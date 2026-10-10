import playcanvasConfig from '@playcanvas/eslint-config';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import globals from 'globals';

export default [
    // ARTLIGHT (TKT-282) : src/render est copié tel quel de l'amont
    // (playcanvas/supersplat-viewer v1.37.0, commit cd0e316 ; dernière
    // modification de ces fichiers : #315, 6a4ab4d). Mis en forme par
    // prettier là-bas, gardé identique pour reprendre ses corrections.
    {
        ignores: ['src/render/**']
    },
    ...playcanvasConfig,
    {
        files: ['**/*.ts'],
        languageOptions: {
            parser: tsParser,
            globals: {
                ...globals.browser
            }
        },
        plugins: {
            '@typescript-eslint': tsPlugin
        },
        rules: {
            'import/default': 'off',
            'import/extensions': 'off',
            'import/no-unresolved': 'off',
            'jsdoc/require-param-type': 'off',
            'jsdoc/require-returns-type': 'off',
            'no-duplicate-imports': 'off'
        }
    },
    {
        files: ['**/*.mjs'],
        languageOptions: {
            globals: {
                ...globals.node
            }
        },
        rules: {
            'import/no-unresolved': 'off'
        }
    }
];
