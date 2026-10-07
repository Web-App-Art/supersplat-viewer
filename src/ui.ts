import { EventHandler } from 'playcanvas';

import { version as appVersion } from '../package.json';
import { localize } from './localization';
import { SPEED_LEVELS } from './move-speed';
import type { Annotation } from './settings';
import { translator } from './tool-panel';
import { isToolActive } from './tool-utils';
import { Tooltip } from './tooltip';
import { Global } from './types';

// Initialize the touch joystick for fly mode camera control
const initJoystick = (
    dom: Record<string, HTMLElement>,
    events: EventHandler,
    state: { cameraMode: string; inputMode: string; gamingControls: boolean }
) => {
    // Joystick dimensions (matches SCSS: base height=100, stick size=40)
    const joystickHeight = 100;
    const stickSize = 40;
    const stickCenterY = (joystickHeight - stickSize) / 2; // 30px - top position when centered
    const stickCenterX = (joystickHeight - stickSize) / 2; // 30px - left position when centered (for 2D mode)
    const maxStickTravel = stickCenterY; // can travel 30px up or down from center

    // Fixed joystick position (bottom-left corner with safe area)
    const joystickFixedX = 70;
    const joystickFixedY = () => window.innerHeight - 140;

    // Joystick touch state
    let joystickPointerId: number | null = null;
    let joystickValueX = 0; // -1 to 1, negative = left, positive = right
    let joystickValueY = 0; // -1 to 1, negative = forward, positive = backward

    // Joystick mode: '1d' for vertical only, '2d' for full directional
    let joystickMode: '1d' | '2d' = '2d';

    // Double-tap detection for mode toggle
    let lastTapTime = 0;

    // Update joystick visibility based on camera mode and input mode
    // ARTLIGHT: comme avant la fusion 1.28, le joystick s'affiche dès qu'on
    // est en drone sur tactile, sans exiger l'option « contrôles de jeu ».
    const updateJoystickVisibility = () => {
        if ((state.cameraMode === 'fly' || state.cameraMode === 'walk') && state.inputMode === 'touch') {
            dom.joystickBase.classList.remove('hidden');
            dom.joystickBase.classList.toggle('mode-2d', joystickMode === '2d');
            dom.joystickBase.style.left = `${joystickFixedX}px`;
            dom.joystickBase.style.top = `${joystickFixedY()}px`;
            // Center the stick
            dom.joystick.style.top = `${stickCenterY}px`;
            if (joystickMode === '2d') {
                dom.joystick.style.left = `${stickCenterX}px`;
            } else {
                dom.joystick.style.left = '8px'; // Reset to 1D centered position
            }
        } else {
            dom.joystickBase.classList.add('hidden');
        }
    };

    events.on('cameraMode:changed', updateJoystickVisibility);
    events.on('inputMode:changed', updateJoystickVisibility);
    events.on('gamingControls:changed', updateJoystickVisibility);
    window.addEventListener('resize', updateJoystickVisibility);

    // Handle joystick touch input directly on the joystick element
    const updateJoystickStick = (clientX: number, clientY: number) => {
        const baseY = joystickFixedY();
        // Calculate Y offset from joystick center (positive = down/backward)
        const offsetY = clientY - baseY;
        // Clamp to max travel and normalize to -1 to 1
        const clampedOffsetY = Math.max(-maxStickTravel, Math.min(maxStickTravel, offsetY));
        joystickValueY = clampedOffsetY / maxStickTravel;

        // Update stick visual Y position
        dom.joystick.style.top = `${stickCenterY + clampedOffsetY}px`;

        // Handle X axis in 2D mode
        if (joystickMode === '2d') {
            const baseX = joystickFixedX;
            const offsetX = clientX - baseX;
            const clampedOffsetX = Math.max(-maxStickTravel, Math.min(maxStickTravel, offsetX));
            joystickValueX = clampedOffsetX / maxStickTravel;

            // Update stick visual X position
            dom.joystick.style.left = `${stickCenterX + clampedOffsetX}px`;
        } else {
            joystickValueX = 0;
        }

        // Fire input event for the input controller
        events.fire('joystickInput', { x: joystickValueX, y: joystickValueY });
    };

    dom.joystickBase.addEventListener('pointerdown', (event: PointerEvent) => {
        // Double-tap detection for mode toggle
        const now = Date.now();
        if (now - lastTapTime < 300) {
            joystickMode = joystickMode === '1d' ? '2d' : '1d';
            updateJoystickVisibility();
            lastTapTime = 0;
        } else {
            lastTapTime = now;
        }

        if (joystickPointerId !== null) return; // Already tracking a touch

        joystickPointerId = event.pointerId;
        dom.joystickBase.setPointerCapture(event.pointerId);

        updateJoystickStick(event.clientX, event.clientY);
        event.preventDefault();
        event.stopPropagation();
    });

    dom.joystickBase.addEventListener('pointermove', (event: PointerEvent) => {
        if (event.pointerId !== joystickPointerId) return;

        updateJoystickStick(event.clientX, event.clientY);
        event.preventDefault();
    });

    const endJoystickTouch = (event: PointerEvent) => {
        if (event.pointerId !== joystickPointerId) return;

        joystickPointerId = null;
        joystickValueX = 0;
        joystickValueY = 0;

        // Reset stick to center
        dom.joystick.style.top = `${stickCenterY}px`;
        if (joystickMode === '2d') {
            dom.joystick.style.left = `${stickCenterX}px`;
        }

        // Fire input event with zero values
        events.fire('joystickInput', { x: 0, y: 0 });

        dom.joystickBase.releasePointerCapture(event.pointerId);
    };

    dom.joystickBase.addEventListener('pointerup', endJoystickTouch);
    dom.joystickBase.addEventListener('pointercancel', endJoystickTouch);
};

// Initialize the annotation navigator for stepping between annotations
const initAnnotationNav = (
    dom: Record<string, HTMLElement>,
    events: EventHandler,
    state: { loaded: boolean; inputMode: string; controlsHidden: boolean; showAnnotations: boolean },
    annotations: Annotation[]
) => {
    // Only show navigator when there are at least 2 annotations
    if (annotations.length < 2) return;

    let currentIndex = 0;

    const updateDisplay = () => {
        dom.annotationNavTitle.textContent = annotations[currentIndex].title || '';
    };

    const updateMode = () => {
        if (!state.loaded) return;
        if (!state.showAnnotations) {
            dom.annotationNav.classList.add('hidden');
            return;
        }
        dom.annotationNav.classList.remove('desktop', 'touch', 'hidden');
        dom.annotationNav.classList.add(state.inputMode);
    };

    const updateFade = () => {
        if (!state.loaded) return;
        dom.annotationNav.classList.toggle('faded-in', !state.controlsHidden);
        dom.annotationNav.classList.toggle('faded-out', state.controlsHidden);
    };

    const goTo = (index: number) => {
        currentIndex = index;
        updateDisplay();
        events.fire('annotation.navigate', annotations[currentIndex]);
    };

    // Prev / Next
    dom.annotationPrev.addEventListener('click', (e) => {
        e.stopPropagation();
        goTo((currentIndex - 1 + annotations.length) % annotations.length);
    });

    dom.annotationNext.addEventListener('click', (e) => {
        e.stopPropagation();
        goTo((currentIndex + 1) % annotations.length);
    });

    // Sync when an annotation is activated externally (e.g. hotspot click)
    events.on('annotation.activate', (annotation: Annotation) => {
        const idx = annotations.indexOf(annotation);
        if (idx !== -1) {
            currentIndex = idx;
            updateDisplay();
        }
    });

    // React to state changes
    events.on('loaded:changed', () => {
        updateMode();
        updateFade();
    });
    events.on('inputMode:changed', updateMode);
    events.on('controlsHidden:changed', updateFade);
    events.on('showAnnotations:changed', () => {
        updateMode();
        updateFade();
    });

    // Initial state
    updateDisplay();
};

// update the poster image to start blurry and then resolve to sharp during loading
const initPoster = (events: EventHandler) => {
    const poster = document.getElementById('poster');

    events.on('loaded:changed', () => {
        poster.style.display = 'none';
        document.documentElement.style.setProperty('--canvas-opacity', '1');
    });

    const blur = (progress: number) => {
        poster.style.filter = `blur(${Math.floor((100 - progress) * 0.4)}px)`;
    };

    events.on('progress:changed', blur);
};

const initUI = (global: Global) => {
    const { config, events, state } = global;

    // Acquire Elements
    const docRoot = document.documentElement;
    const dom = [
        'ui',
        'controlsWrap',
        'arMode', 'vrMode',
        // 'enterFullscreen', 'exitFullscreen',
        'info', 'infoPanel', 'desktopTab', 'touchTab', 'desktopInfoPanel', 'touchInfoPanel',
        'timelineContainer', 'handle', 'time',
        'buttonsContainer',
        'play', 'pause',
        'settings', 'settingsPanel',
        'annotationsRow', 'annotationsOption', 'annotationsCheck',
        'orbitCamera', 'flyCamera', 'fpsCamera',
        'performanceModeRow', 'performanceModeCheck', 'performanceModeOption',
        'gamingControlsDivider', 'gamingControlsRow', 'gamingControlsCheck', 'gamingControlsOption',
        'desktopFlyClickToFly', 'desktopFlyGamingControls', 'desktopClickToWalk', 'desktopGamingControls',
        'touchFlyClickToWalk', 'touchFlyGamingControls',
        'touchClickToWalk', 'touchGamingControls',
        'walkHint',
        'speedName', 'speedLevels', 'speedHint',
        'reset', 'frame',
        'loadingText', 'loadingBar',
        'joystickBase', 'joystick',
        'desktopShowCollisionHelp',
        // ARTLIGHT
        'navMenu', 'navBar', 'toolsMenu', 'toolsMenuIcon', 'toolsBar',
        'collisionRow', 'collisionCheck',
        'measure',
        'areaMeasure',
        'flatnessMeasure',
        'volumeMeasure',
        'pointXYZ',
        'section',
        'contentMode',
        'tooltip',
        'annotationNav', 'annotationPrev', 'annotationNext', 'annotationInfo', 'annotationNavTitle',
        'viewerTitle', 'appVersionLabel',
        'xrModal', 'xrModalOk', 'xrModalCancel'
    ].reduce((acc: Record<string, HTMLElement>, id) => {
        acc[id] = document.getElementById(id) ?? document.createElement('div');
        return acc;
    }, {});

    // populate the info-panel title with the app version
    dom.appVersionLabel.textContent = appVersion;

    // Remove focus from buttons after click so keyboard input isn't captured by the UI
    // ARTLIGHT (TKT-236) : sauf le clic qui entre dans un champ de saisie. Le
    // champ recevait le focus puis le perdait aussitôt : impossible d'y taper.
    const textFields = 'input:not([type="button"]):not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="submit"]), textarea, select, [contenteditable]';
    dom.ui.addEventListener('click', (event: MouseEvent) => {
        const active = document.activeElement as HTMLElement | null;
        const target = event.target as HTMLElement | null;
        const editing = active?.matches?.(textFields) &&
            (active.contains(target) || !!target?.closest?.('label')?.contains(active));
        if (editing) return;
        active?.blur();
    });

    // ARTLIGHT (TKT-236) : élément entre la cible et #ui qui défile lui-même
    // (panneau d'outil plus haut que l'écran).
    const scrollsItself = (target: HTMLElement | null) => {
        for (let node = target; node && node !== dom.ui; node = node.parentElement) {
            const { overflowY } = getComputedStyle(node);
            if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight + 1) {
                return true;
            }
        }
        return false;
    };

    // Forward wheel events from UI overlays to the canvas so the camera zooms
    // instead of the page scrolling (e.g. annotation nav, tooltips, hotspots).
    // The non-standard wheelDelta{X,Y} properties aren't part of WheelEventInit,
    // so they get dropped by `new WheelEvent(type, init)`. We re-attach them so
    // the trackpad-vs-mouse classifier in input-controller.ts behaves the same
    // whether the event originated on the canvas or was forwarded from the UI.
    const canvas = global.app.graphicsDevice.canvas as HTMLCanvasElement;
    dom.ui.addEventListener('wheel', (event: WheelEvent) => {
        // ARTLIGHT (TKT-236) : au-dessus d'un panneau qui défile, la molette
        // fait défiler le panneau au lieu de zoomer la caméra.
        if (scrollsItself(event.target as HTMLElement)) return;
        event.preventDefault();
        const forwarded = new WheelEvent(event.type, event);
        const src = event as WheelEvent & {
            wheelDelta?: number, wheelDeltaX?: number, wheelDeltaY?: number
        };
        for (const key of ['wheelDelta', 'wheelDeltaX', 'wheelDeltaY'] as const) {
            if (typeof src[key] === 'number') {
                Object.defineProperty(forwarded, key, { value: src[key], configurable: true });
            }
        }
        canvas.dispatchEvent(forwarded);
    }, { passive: false });

    // Tailwind lime palette (hex) for loading bar styling
    const lime500 = '#84CC16';
    const lime100 = '#ECFCCB';

    // Handle loading progress updates
    events.on('progress:changed', (progress) => {
        dom.loadingText.textContent = `${progress}%`;
        if (progress < 100) {
            dom.loadingBar.style.backgroundImage = `linear-gradient(90deg, ${lime500} 0%, ${lime500} ${progress}%, ${lime100} ${progress}%, ${lime100} 100%)`;
        } else {
            dom.loadingBar.style.backgroundImage = `linear-gradient(90deg, ${lime500} 0%, ${lime500} 100%)`;
        }
    });

    // Hide loading bar once loaded
    events.on('loaded:changed', () => {
        document.getElementById('loadingWrap').classList.add('hidden');
    });

    // // Fullscreen support
    // const hasFullscreenAPI = docRoot.requestFullscreen && document.exitFullscreen;
    //
    // const requestFullscreen = () => {
    //     if (hasFullscreenAPI) {
    //         docRoot.requestFullscreen();
    //     } else {
    //         window.parent.postMessage('requestFullscreen', '*');
    //         state.isFullscreen = true;
    //     }
    // };
    //
    // const exitFullscreen = () => {
    //     if (hasFullscreenAPI) {
    //         if (document.fullscreenElement) {
    //             document.exitFullscreen().catch(() => {});
    //         }
    //     } else {
    //         window.parent.postMessage('exitFullscreen', '*');
    //         state.isFullscreen = false;
    //     }
    // };
    //
    // if (hasFullscreenAPI) {
    //     document.addEventListener('fullscreenchange', () => {
    //         state.isFullscreen = !!document.fullscreenElement;
    //     });
    // }
    //
    // dom.enterFullscreen.addEventListener('click', requestFullscreen);
    // dom.exitFullscreen.addEventListener('click', exitFullscreen);
    //
    // // toggle fullscreen when user switches between landscape portrait
    // // orientation
    // screen?.orientation?.addEventListener('change', (event) => {
    //     if (['landscape-primary', 'landscape-secondary'].includes(screen.orientation.type)) {
    //         requestFullscreen();
    //     } else {
    //         exitFullscreen();
    //     }
    // });
    //
    // // update UI when fullscreen state changes
    // events.on('isFullscreen:changed', (value) => {
    //     dom.enterFullscreen.classList[value ? 'add' : 'remove']('hidden');
    //     dom.exitFullscreen.classList[value ? 'remove' : 'add']('hidden');
    // });

    // Performance mode toggle
    dom.performanceModeRow.addEventListener('click', () => {
        state.performanceMode = !state.performanceMode;
    });

    const updatePerformanceMode = () => {
        dom.performanceModeCheck.classList.toggle('active', state.performanceMode);
    };
    events.on('performanceMode:changed', updatePerformanceMode);
    updatePerformanceMode();

    // ARTLIGHT (TKT-241): vitesse de déplacement, 5 niveaux
    const trSpeed = translator('artlight.speed');
    const speedName = (level: number) => trSpeed(`level-${level}`);
    const speedButtons = Array.from(dom.speedLevels.querySelectorAll<HTMLButtonElement>('button'));
    speedButtons.forEach((button) => {
        const level = Number(button.dataset.level);
        button.title = speedName(level);
        button.addEventListener('click', () => {
            state.speedLevel = level;
        });
    });

    const updateSpeedLevel = () => {
        speedButtons.forEach((button) => {
            const active = Number(button.dataset.level) === state.speedLevel;
            button.classList.toggle('active', active);
            button.setAttribute('aria-pressed', String(active));
        });
        dom.speedName.textContent = speedName(state.speedLevel);
    };
    events.on('speedLevel:changed', updateSpeedLevel);
    updateSpeedLevel();

    // Raccourcis + et − : en vol la souris est souvent capturée et le panneau
    // fermé, un bandeau confirme le niveau quelques instants.
    let speedHintTimeout: ReturnType<typeof setTimeout> | null = null;
    events.on('inputEvent', (type: string) => {
        if (type !== 'speedUp' && type !== 'speedDown') return;
        const step = type === 'speedUp' ? 1 : -1;
        state.speedLevel = Math.min(SPEED_LEVELS, Math.max(1, state.speedLevel + step));
        dom.speedHint.textContent = trSpeed('hint', {
            name: speedName(state.speedLevel),
            level: state.speedLevel,
            max: SPEED_LEVELS
        });
        dom.speedHint.classList.remove('hidden');
        clearTimeout(speedHintTimeout);
        speedHintTimeout = setTimeout(() => dom.speedHint.classList.add('hidden'), 1500);
    });

    // Gaming mode toggle (settings row visible on mobile only)
    dom.gamingControlsRow.addEventListener('click', () => {
        state.gamingControls = !state.gamingControls;
    });

    const updateGamingSettingsVisibility = () => {
        const isDesktop = state.inputMode === 'desktop';
        dom.gamingControlsDivider.classList.toggle('hidden', isDesktop);
        dom.gamingControlsRow.classList.toggle('hidden', isDesktop);
    };
    events.on('inputMode:changed', updateGamingSettingsVisibility);
    updateGamingSettingsVisibility();

    const updateGamingControls = () => {
        dom.gamingControlsCheck.classList.toggle('active', state.gamingControls);
        dom.desktopFlyClickToFly.classList.toggle('hidden', state.gamingControls);
        dom.desktopFlyGamingControls.classList.toggle('hidden', !state.gamingControls);
        dom.desktopClickToWalk.classList.toggle('hidden', state.gamingControls);
        dom.desktopGamingControls.classList.toggle('hidden', !state.gamingControls);
        dom.touchFlyClickToWalk.classList.toggle('hidden', state.gamingControls);
        dom.touchFlyGamingControls.classList.toggle('hidden', !state.gamingControls);
        dom.touchClickToWalk.classList.toggle('hidden', state.gamingControls);
        dom.touchGamingControls.classList.toggle('hidden', !state.gamingControls);
    };

    events.on('gamingControls:changed', updateGamingControls);
    events.on('inputMode:changed', updateGamingControls);
    updateGamingControls();

    // Annotation visibility toggle
    const updateAnnotationsVisibility = () => {
        dom.annotationsRow.classList.toggle('hidden', global.settings.annotations.length === 0);
        dom.annotationsCheck.classList.toggle('active', state.showAnnotations);
        global.app.renderNextFrame = true;
    };

    dom.annotationsRow.addEventListener('click', () => {
        state.showAnnotations = !state.showAnnotations;
    });

    events.on('showAnnotations:changed', updateAnnotationsVisibility);
    updateAnnotationsVisibility();

    // persist user preferences on change (never at startup, so defaults are not written into storage)
    events.on('performanceMode:changed', (value: boolean) => localStorage.setItem('performanceMode', String(value)));
    events.on('gamingControls:changed', (value: boolean) => localStorage.setItem('gamingControls', String(value)));
    events.on('showAnnotations:changed', (value: boolean) => localStorage.setItem('showAnnotations', String(value)));

    // AR/VR
    const arChanged = () => dom.arMode.classList[state.hasAR ? 'remove' : 'add']('hidden');
    const vrChanged = () => dom.vrMode.classList[state.hasVR ? 'remove' : 'add']('hidden');

    // When a session can't start on the current (WebGPU) device but would work on
    // WebGL, prompt the user to reload the viewer with the WebGL renderer before
    // starting AR/VR. Use replace() so the renderer-switch reload doesn't add a
    // back-button entry — important because the viewer often runs inside an
    // iframe (e.g. superspl.at /scene).
    const reloadWithWebgl = () => {
        const reloadUrl = new URL(location.href);
        reloadUrl.searchParams.set('webgl', '');
        location.replace(reloadUrl.toString());
    };

    const showXrModal = () => dom.xrModal.classList.remove('hidden');
    const hideXrModal = () => dom.xrModal.classList.add('hidden');

    dom.xrModalOk.addEventListener('click', reloadWithWebgl);
    dom.xrModalCancel.addEventListener('click', hideXrModal);
    dom.xrModal.addEventListener('pointerdown', hideXrModal);

    const handleXrClick = (type: 'AR' | 'VR') => {
        // Availability is backend-aware: when the session can start on the current
        // device (WebGPU included), start it directly. Otherwise the button is only
        // visible because the session would work on WebGL, so offer the reload.
        if (global.app.xr.isAvailable(type === 'AR' ? 'immersive-ar' : 'immersive-vr')) {
            events.fire(type === 'AR' ? 'startAR' : 'startVR');
        } else {
            showXrModal();
        }
    };

    dom.arMode.addEventListener('click', () => handleXrClick('AR'));
    dom.vrMode.addEventListener('click', () => handleXrClick('VR'));

    events.on('hasAR:changed', arChanged);
    events.on('hasVR:changed', vrChanged);

    arChanged();
    vrChanged();

    // Info panel
    const updateInfoTab = (tab: 'desktop' | 'touch') => {
        if (tab === 'desktop') {
            dom.desktopTab.classList.add('active');
            dom.touchTab.classList.remove('active');
            dom.desktopInfoPanel.classList.remove('hidden');
            dom.touchInfoPanel.classList.add('hidden');
        } else {
            dom.desktopTab.classList.remove('active');
            dom.touchTab.classList.add('active');
            dom.desktopInfoPanel.classList.add('hidden');
            dom.touchInfoPanel.classList.remove('hidden');
        }
    };

    dom.desktopTab.addEventListener('click', () => {
        updateInfoTab('desktop');
    });

    dom.touchTab.addEventListener('click', () => {
        updateInfoTab('touch');
    });

    const toggleHelp = () => {
        updateInfoTab(state.inputMode);
        dom.infoPanel.classList.toggle('hidden');
    };

    dom.info.addEventListener('click', toggleHelp);

    dom.infoPanel.addEventListener('pointerdown', () => {
        dom.infoPanel.classList.add('hidden');
    });

    // ARTLIGHT (TKT-242) : la barre principale ne garde que deux menus,
    // Navigation et Outils, qui ouvrent chacun leur barre au-dessus. Un seul
    // menu, ou le panneau Paramètres, ouvert à la fois ; un clic ailleurs ou
    // Échap le referme.
    type Menu = { button: HTMLElement, bar: HTMLElement };
    const menus: Menu[] = [
        { button: dom.navMenu, bar: dom.navBar },
        { button: dom.toolsMenu, bar: dom.toolsBar }
    ];
    let openMenu: Menu | null = null;

    // Centrée sur son bouton, sans déborder de la barre principale. La largeur
    // est mesurée calée à gauche puis figée : décalée, la barre perdrait la
    // fraction de pixel qui garde ses boutons sur une ligne.
    const placeMenuBar = ({ button, bar }: Menu) => {
        bar.style.left = '0px';
        bar.style.width = '';
        const width = Math.ceil(bar.getBoundingClientRect().width);
        const container = dom.buttonsContainer.getBoundingClientRect();
        const anchor = button.getBoundingClientRect();
        const center = anchor.left + anchor.width / 2 - container.left;
        const left = Math.max(0, Math.min(center - width / 2, container.width - width));
        bar.style.width = `${width}px`;
        bar.style.left = `${left}px`;
        bar.style.setProperty('--caret-x', `${center - left}px`);
    };

    const closeMenus = () => {
        if (!openMenu) return;
        openMenu.bar.classList.add('hidden');
        openMenu.button.classList.remove('open');
        openMenu.button.setAttribute('aria-expanded', 'false');
        openMenu = null;
    };

    const toggleMenu = (menu: Menu) => {
        const wasOpen = openMenu === menu;
        closeMenus();
        if (wasOpen) return;
        dom.settingsPanel.classList.add('hidden');
        menu.bar.classList.remove('hidden');
        menu.button.classList.add('open');
        menu.button.setAttribute('aria-expanded', 'true');
        placeMenuBar(menu);
        openMenu = menu;
    };

    menus.forEach((menu) => {
        menu.button.addEventListener('click', () => toggleMenu(menu));
    });

    // Clic hors du menu ouvert : scène, panneau d'outil ou autre bouton.
    document.addEventListener('pointerdown', (event: PointerEvent) => {
        const target = event.target as Node;
        if (openMenu && !openMenu.bar.contains(target) && !openMenu.button.contains(target)) {
            closeMenus();
        }
    }, true);

    window.addEventListener('resize', () => {
        if (openMenu) placeMenuBar(openMenu);
    });

    events.on('inputEvent', (event) => {
        if (event === 'toggleHelp') {
            toggleHelp();
        } else if (event === 'cancel') {
            // close info panel on cancel
            dom.infoPanel.classList.add('hidden');
            dom.settingsPanel.classList.add('hidden');
            closeMenus(); // ARTLIGHT (TKT-242)

            // // close fullscreen on cancel
            // if (state.isFullscreen) {
            //     exitFullscreen();
            // }
        } else if (event === 'interrupt') {
            dom.settingsPanel.classList.add('hidden');
            closeMenus();
        }
    });

    // fade ui controls after 5 seconds of inactivity
    events.on('controlsHidden:changed', (value) => {
        dom.controlsWrap.classList.toggle('faded-out', value);
        dom.controlsWrap.classList.toggle('faded-in', !value);
    });

    // show the ui and start a timer to hide it again
    let uiTimeout: ReturnType<typeof setTimeout> | null = null;
    let annotationVisible = false;

    const isPointerCapturedMode = () => (
        state.inputMode === 'desktop' &&
        state.gamingControls &&
        (state.cameraMode === 'walk' || state.cameraMode === 'fly')
    );

    const hideUI = () => {
        if (uiTimeout) {
            clearTimeout(uiTimeout);
            uiTimeout = null;
        }
        dom.infoPanel.classList.add('hidden');
        dom.settingsPanel.classList.add('hidden');
        closeMenus();
        dom.walkHint.classList.add('hidden');
        state.controlsHidden = true;
    };

    const showUI = () => {
        if (isPointerCapturedMode()) {
            hideUI();
            return;
        }
        if (uiTimeout) {
            clearTimeout(uiTimeout);
        }
        state.controlsHidden = false;
        uiTimeout = setTimeout(() => {
            uiTimeout = null;
            if (!annotationVisible && !isToolActive(state) && !openMenu) {
                state.controlsHidden = true;
            }
        }, 4000);
    };

    // Show controls once loaded
    events.on('loaded:changed', () => {
        dom.controlsWrap.classList.remove('hidden');
        showUI();
    });

    events.on('inputEvent', showUI);

    const updateCapturedUI = () => {
        if (isPointerCapturedMode()) {
            hideUI();
        } else {
            showUI();
        }
    };

    events.on('cameraMode:changed', updateCapturedUI);
    events.on('inputMode:changed', updateCapturedUI);
    events.on('gamingControls:changed', updateCapturedUI);

    // keep UI visible while an annotation tooltip is shown
    events.on('annotation.activate', () => {
        annotationVisible = true;
        showUI();
    });

    events.on('annotation.deactivate', () => {
        annotationVisible = false;
        showUI();
    });

    // Animation controls
    events.on('hasAnimation:changed', (value, prev) => {
        // Start and Stop animation
        dom.play.addEventListener('click', () => {
            state.cameraMode = 'anim';
            state.animationPaused = false;
        });

        dom.pause.addEventListener('click', () => {
            state.cameraMode = 'anim';
            state.animationPaused = true;
        });

        const updatePlayPause = () => {
            if (state.cameraMode !== 'anim' || state.animationPaused) {
                dom.play.classList.remove('hidden');
                dom.pause.classList.add('hidden');
            } else {
                dom.play.classList.add('hidden');
                dom.pause.classList.remove('hidden');
            }

            if (state.cameraMode === 'anim') {
                dom.timelineContainer.classList.remove('hidden');
            } else {
                dom.timelineContainer.classList.add('hidden');
            }
        };

        // Update UI on animation changes
        events.on('cameraMode:changed', updatePlayPause);
        events.on('animationPaused:changed', updatePlayPause);

        const updateSlider = () => {
            dom.handle.style.left = `${state.animationTime / state.animationDuration * 100}%`;
            dom.time.style.left = `${state.animationTime / state.animationDuration * 100}%`;
            dom.time.innerText = `${state.animationTime.toFixed(1)}s`;
        };

        events.on('animationTime:changed', updateSlider);
        events.on('animationLength:changed', updateSlider);

        const handleScrub = (event: PointerEvent) => {
            const rect = dom.timelineContainer.getBoundingClientRect();
            const t = Math.max(0, Math.min(rect.width - 1, event.clientX - rect.left)) / rect.width;
            events.fire('scrubAnim', state.animationDuration * t);
            showUI();
        };

        let paused = false;
        let captured = false;

        dom.timelineContainer.addEventListener('pointerdown', (event: PointerEvent) => {
            if (!captured) {
                handleScrub(event);
                dom.timelineContainer.setPointerCapture(event.pointerId);
                dom.time.classList.remove('hidden');
                paused = state.animationPaused;
                state.animationPaused = true;
                captured = true;
            }
        });

        dom.timelineContainer.addEventListener('pointermove', (event: PointerEvent) => {
            if (captured) {
                handleScrub(event);
            }
        });

        dom.timelineContainer.addEventListener('pointerup', (event) => {
            if (captured) {
                dom.timelineContainer.releasePointerCapture(event.pointerId);
                dom.time.classList.add('hidden');
                state.animationPaused = paused;
                captured = false;
            }
        });
    });

    // Camera mode UI
    // ARTLIGHT (TKT-242) : le bouton Navigation montre le mode en cours ; il
    // garde le précédent pendant une animation de caméra.
    const navIcons: Record<string, string> = { orbit: '#orbitIcon', fly: '#flyIcon', walk: '#walkIcon' };
    const updateCameraModeUI = () => {
        dom.orbitCamera.classList.toggle('active', state.cameraMode === 'orbit');
        dom.flyCamera.classList.toggle('active', state.cameraMode === 'fly');
        dom.fpsCamera.classList.toggle('active', state.cameraMode === 'walk');
        const icon = navIcons[state.cameraMode];
        if (icon) {
            dom.navMenu.querySelectorAll('use').forEach(use => use.setAttribute('href', icon));
        }
    };

    events.on('cameraMode:changed', updateCameraModeUI);
    updateCameraModeUI();

    // Walk mode hint banner (shown once per session on first FPS entry)
    let walkHintShown = false;

    const getWalkHintText = () => {
        if (state.inputMode === 'desktop') {
            return localize('walk-hint.desktop');
        }
        return localize(state.gamingControls ? 'walk-hint.touch-gaming' : 'walk-hint.touch-tap');
    };

    events.on('cameraMode:changed', (value: string) => {
        if (value === 'walk' && !walkHintShown && !isPointerCapturedMode()) {
            walkHintShown = true;
            dom.walkHint.textContent = getWalkHintText();
            dom.walkHint.classList.remove('hidden');
        } else if (value !== 'walk') {
            dom.walkHint.classList.add('hidden');
        }
    });

    const dismissWalkHint = () => dom.walkHint.classList.add('hidden');

    dom.walkHint.addEventListener('click', dismissWalkHint);
    events.on('inputEvent', (type: string) => {
        if (type === 'interrupt') dismissWalkHint();
    });

    // show/hide the FPS button based on whether walk mode is offered
    // (collision data exists AND scene is large enough to walk around in)
    events.on('walkAllowed:changed', (value: boolean) => {
        dom.fpsCamera.classList.toggle('hidden', !value);
        // adjust fly button shape: middle when FPS is visible, right when hidden
        dom.flyCamera.classList.toggle('middle', value);
        dom.flyCamera.classList.toggle('right', !value);
    });

    // Collision overlay toggle + matching help-panel row (only visible when overlay is available)
    // ARTLIGHT (TKT-242) : l'interrupteur est dans Paramètres, plus dans la barre.
    events.on('hasCollisionOverlay:changed', (value: boolean) => {
        dom.collisionRow.classList.toggle('hidden', !value);
        dom.desktopShowCollisionHelp.classList.toggle('hidden', !value);
    });

    dom.collisionRow.addEventListener('click', () => {
        state.collisionOverlayEnabled = !state.collisionOverlayEnabled;
    });

    events.on('collisionOverlayEnabled:changed', (value: boolean) => {
        dom.collisionCheck.classList.toggle('active', value);
    });

    // ARTLIGHT: outils de mesure, un seul ouvert à la fois. L'outil quitté se
    // referme avant que le nouveau s'ouvre : chacun rend le curseur qu'il a
    // trouvé en s'ouvrant.
    type ToolMode = 'measureMode' | 'areaMeasureMode' | 'flatnessMeasureMode' | 'volumeMeasureMode' |
        'pointMode' | 'sectionMode';
    const toolButtons: [ToolMode, HTMLElement][] = [
        ['measureMode', dom.measure],
        ['areaMeasureMode', dom.areaMeasure],
        ['flatnessMeasureMode', dom.flatnessMeasure],
        ['volumeMeasureMode', dom.volumeMeasure],
        ['pointMode', dom.pointXYZ],
        ['sectionMode', dom.section]
    ];
    // ARTLIGHT (TKT-242) : le bouton Outils prend l'icône de l'outil ouvert.
    const toolsMenuIcon = dom.toolsMenuIcon.innerHTML;
    const updateToolsMenu = () => {
        const open = toolButtons.find(([mode]) => state[mode]);
        dom.toolsMenu.classList.toggle('active', !!open);
        if (open) {
            dom.toolsMenuIcon.replaceChildren(open[1].querySelector('svg').cloneNode(true));
        } else {
            dom.toolsMenuIcon.innerHTML = toolsMenuIcon;
        }
    };

    for (const [mode, button] of toolButtons) {
        button.addEventListener('click', () => {
            closeMenus();
            const open = !state[mode];
            if (open) {
                for (const [other] of toolButtons) {
                    if (other !== mode) state[other] = false;
                }
            }
            state[mode] = open;
        });
        events.on(`${mode}:changed`, (value: boolean) => {
            button.classList.toggle('active', value);
            updateToolsMenu();
        });
    }

    // ARTLIGHT (TKT-228): bascule Splats / Nuage de points. La page est
    // rechargée avec l'autre contenu (voir content-mode.ts).
    if (config.splatsUrl && config.pointcloudUrl) {
        dom.contentMode.classList.remove('hidden');
        dom.contentMode.classList.toggle('active', config.contentMode === 'pointcloud');
        dom.contentMode.addEventListener('click', () => {
            events.fire('contentMode:switch', config.contentMode === 'pointcloud' ? 'splats' : 'pointcloud');
        });
    }

    dom.settings.addEventListener('click', () => {
        dom.settingsPanel.classList.toggle('hidden');
    });

    dom.orbitCamera.addEventListener('click', () => {
        closeMenus();
        state.cameraMode = 'orbit';
    });

    dom.flyCamera.addEventListener('click', () => {
        closeMenus();
        state.cameraMode = 'fly';
    });

    dom.fpsCamera.addEventListener('click', () => {
        events.fire('inputEvent', 'toggleWalk');
    });

    dom.reset.addEventListener('click', (event) => {
        closeMenus();
        events.fire('inputEvent', 'reset', event);
    });

    dom.frame.addEventListener('click', (event) => {
        closeMenus();
        events.fire('inputEvent', 'frame', event);
    });

    // Initialize touch joystick for fly mode
    initJoystick(dom, events, state);

    // Initialize annotation navigator
    initAnnotationNav(dom, events, state, global.settings.annotations);

    // Hide all UI (poster, loading bar, controls)
    if (config.noui) {
        dom.ui.classList.add('hidden');
    }

    // tooltips
    const tooltip = new Tooltip(dom.tooltip);

    tooltip.register(dom.play, localize('tooltip.play'), 'top');
    tooltip.register(dom.pause, localize('tooltip.pause'), 'top');
    // ARTLIGHT: le fork traduisait les libellés à la main ; l'amont porte
    // désormais une vraie i18n (9 langues), nos outils s'y rangent.
    // ARTLIGHT (TKT-242) : les boutons des barres Navigation et Outils portent
    // leur libellé, sans infobulle.
    tooltip.register(dom.navMenu, localize('tooltip.artlight-navigation'), 'top');
    tooltip.register(dom.toolsMenu, localize('tooltip.artlight-tools'), 'top');
    tooltip.register(dom.contentMode, localize('tooltip.artlight-pointcloud'), 'top');
    tooltip.register(dom.settings, localize('tooltip.settings'), 'top');
    tooltip.register(dom.info, localize('tooltip.help'), 'top');
    tooltip.register(dom.arMode, localize('tooltip.enter-ar'), 'top');
    tooltip.register(dom.vrMode, localize('tooltip.enter-vr'), 'top');
    // ARTLIGHT: le bouton plein écran est retiré (index.html + liste d'ids
    // ci-dessus), `dom.enterFullscreen` est donc undefined. Réintroduire ces
    // deux lignes fait planter initUI au démarrage, écran gris.
    // tooltip.register(dom.enterFullscreen, localize('tooltip.fullscreen'), 'top');
    // tooltip.register(dom.exitFullscreen, localize('tooltip.fullscreen'), 'top');

    const isThirdPartyEmbedded = () => {
        try {
            return window.location.hostname !== window.parent.location.hostname;
        } catch (e) {
            // cross-origin iframe — parent location is inaccessible
            return true;
        }
    };

    if (window.parent !== window && isThirdPartyEmbedded()) {
        const viewUrl = new URL(window.location.href);
        if (viewUrl.pathname === '/s') {
            viewUrl.pathname = '/view';
        }

        (dom.viewerTitle as HTMLAnchorElement).href = viewUrl.toString();
    }
};

export { initPoster, initUI };
