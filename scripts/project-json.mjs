// ARTLIGHT (TKT-297)
//
// Réécriture ciblée d'un project.json : remplacer ou ajouter le bloc « map »
// d'une scène sans toucher au reste du texte (scene-map.mjs build,
// publier-scene.mjs carte).
//
// Le bloc « map » dans la scène sans toucher au reste du fichier.
// TKT-297 : on ne compare plus le fichier à JSON.stringify(…, 2) (refusé dès
// qu'un nombre était écrit « 1.380 », Belgentier, ou qu'un bloc était tenu sur
// une ligne, Saint-Germain) : on repère dans le TEXTE la valeur de
// scenes[i].map (ou la fin de l'objet de la scène) et on la remplace seule. Le
// reste du fichier est gardé octet pour octet, et le résultat est relu.
export const formatMapBlock = (block, indent) => {
    const value = v => (Array.isArray(v) ? `[${v.map(x => JSON.stringify(x)).join(', ')}]` : JSON.stringify(v));
    const line = l => `${indent}    {${Object.entries(l).map(([k, v]) => `${JSON.stringify(k)}: ${value(v)}`).join(', ')}}`;
    return `{\n${block.north === undefined ? '' : `${indent}  "north": ${block.north},\n`}` +
        `${indent}  "levels": [\n${(block.levels ?? []).map(line).join(',\n')}\n${indent}  ]\n${indent}}`;
};

// Analyse minimale d'un texte JSON qui garde les positions : chaque valeur
// rend { start, end } et, pour un objet, ses membres { key, keyStart, value },
// pour un tableau, ses éléments.
export const jsonSpans = (text) => {
    let i = 0;
    const ws = () => {
        while (i < text.length && ' \t\r\n'.includes(text[i])) i++;
    };
    const str = () => {
        const start = i++;
        while (text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
        i++;
        return JSON.parse(text.slice(start, i));
    };
    const value = () => {
        ws();
        const start = i;
        const c = text[i];
        if (c === '{') {
            i++;
            const members = [];
            ws();
            if (text[i] === '}') i++;
            else {
                for (;;) {
                    ws();
                    const keyStart = i;
                    const key = str();
                    ws();
                    i++; // :
                    members.push({ key, keyStart, value: value() });
                    ws();
                    if (text[i++] === '}') break;
                }
            }
            return { start, end: i, members };
        }
        if (c === '[') {
            i++;
            const items = [];
            ws();
            if (text[i] === ']') i++;
            else {
                for (;;) {
                    items.push(value());
                    ws();
                    if (text[i++] === ']') break;
                }
            }
            return { start, end: i, items };
        }
        if (c === '"') {
            str();
            return { start, end: i };
        }
        while (i < text.length && !',}] \t\r\n'.includes(text[i])) i++;
        return { start, end: i };
    };
    return value();
};

const indentAt = (text, pos) => {
    const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
    return /^[ \t]*/.exec(text.slice(lineStart))[0];
};

// Texte du project.json avec le bloc « map » de la scène remplacé ou ajouté.
export const spliceMapBlock = (text, sceneId, block) => {
    const root = jsonSpans(text);
    const scenesNode = root.members?.find(m => m.key === 'scenes')?.value;
    const sceneNode = scenesNode?.items?.find(item => item.members?.some(m => m.key === 'id' && JSON.parse(text.slice(m.value.start, m.value.end)) === sceneId));
    if (!sceneNode || !sceneNode.members.length) return null;
    const existing = sceneNode.members.find(m => m.key === 'map');
    let out;
    if (existing) {
        const indent = indentAt(text, existing.keyStart);
        out = text.slice(0, existing.value.start) + formatMapBlock(block, indent) + text.slice(existing.value.end);
    } else {
        const last = sceneNode.members[sceneNode.members.length - 1];
        const indent = indentAt(text, last.keyStart);
        const sameLine = !text.slice(sceneNode.start, last.keyStart).includes('\n');
        const sep = sameLine ? ', ' : `,\n${indent}`;
        out = `${text.slice(0, last.value.end)}${sep}"map": ${formatMapBlock(block, sameLine ? '' : indent)}${text.slice(last.value.end)}`;
    }
    // relecture : seul le bloc map de la scène doit avoir changé
    const expected = JSON.parse(text);
    expected.scenes.find(x => x.id === sceneId).map = block;
    return JSON.stringify(JSON.parse(out)) === JSON.stringify(expected) ? out : null;
};
