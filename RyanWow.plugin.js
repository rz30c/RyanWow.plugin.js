/**
 * RyanWow.plugin.js
 * RyanWow — Ultimate protection + Matrix GUI + settings + logs
 * Place into Vencord User Plugins folder (Open User Plugins Folder) then restart Discord and enable.
 */

/* Globals used:
   window.Vencord - the Vencord client object
   window.Vencord.Api.* - various helper APIs (UserStore, AudioModule, MessageActions, Toaster)
   FluxDispatcher from Vencord API webpack
*/

(function () {
    // safety: avoid double-registering
    if (window.__RYANWOW_PLUGIN_LOADED__) return;
    window.__RYANWOW_PLUGIN_LOADED__ = true;

    const V = window.Vencord || {};
    const Api = V.Api || {};
    const FluxDispatcher = Api.Webpack?.FluxDispatcher || (window.Vencord?.Api?.Webpack?.FluxDispatcher);
    const UserStore = Api.UserStore || (V.Api && V.Api.UserStore) || (V.UserStore);
    const AudioModule = Api.AudioModule || (V.Api && V.Api.AudioModule);
    const MessageActions = Api.MessageActions || (V.Api && V.Api.MessageActions);
    const Toaster = Api.Toasts || (V.Api && V.Api.Toasts);

    // --- Config & state ---
    const PLUGIN_NAME = "RyanWow";
    let myId = null;
    let lastChannel = null;
    let autoReturn = true;
    let sendDM = true;
    let playSoundOnPull = true;
    let ultraProtect = false; // aggressive (attempts to re-pull instantly with REST if possible)
    let themeColor = "#00ff44"; // matrix green
    let log = []; // {time, userId, userName, action}
    let fluxToken = null;
    let monitoringInterval = null;
    let gui = null;
    let quickBtn = null;
    let draggable = null;

    // rate-limit cache to avoid spamming actions
    const pullCache = new Map(); // key -> timestamp

    // --- Helpers ---
    function nowStr() { return new Date().toLocaleString(); }
    function safeLog(entry) {
        log.unshift(entry);
        if (log.length > 100) log.pop();
        renderLog();
    }
    function playPing() {
        if (!playSoundOnPull) return;
        try {
            const a = new Audio("https://assets.mixkit.co/sfx/download/mixkit-fast-double-click-on-mouse-275.wav");
            a.volume = 0.6;
            a.play();
        } catch (e) { /* ignore */ }
    }
    function toast(msg, timeout = 3500) {
        try {
            if (Toaster && Toaster.show) Toaster.show({ message: msg, duration: timeout });
            else console.log("[RyanWow toast]", msg);
        } catch (e) { console.log("[RyanWow toast error]", e); }
    }
    function sendDMToUser(targetId, message) {
        if (!MessageActions || !MessageActions.sendMessage) {
            toast("Could not send DM: API not available", 3000);
            return;
        }
        try {
            // best-effort send message to user DM (some APIs need channel creation) - fallback to simple sendMessage
            MessageActions.sendMessage(targetId, { content: message });
        } catch (e) { console.log("RyanWow DM error", e); }
    }
    function tryJoinChannel(channelId) {
        try {
            if (AudioModule && AudioModule.joinChannel) {
                AudioModule.joinChannel(channelId);
                return true;
            }
            return false;
        } catch (e) { console.log("RyanWow join error", e); return false; }
    }

    // REST pull attempt (aggressive) - best-effort, will fail without perms
    function restMoveMember(guildId, userId, channelId) {
        try {
            const key = `${userId}-${channelId}`;
            const last = pullCache.get(key) || 0;
            if (Date.now() - last < 3000) return;
            pullCache.set(key, Date.now());

            // Using Vencord RestAPI if available
            const RestAPI = V.Api?.RestAPI || (V.RestAPI);
            if (RestAPI && RestAPI.patch) {
                RestAPI.patch({
                    url: `/guilds/${guildId}/members/${userId}`,
                    body: { channel_id: channelId }
                }).catch(() => {});
                return;
            }
            // else attempt generic fetch (may be rate-limited / need token)
            // Avoid implementing raw token calls to stay client-safe.
        } catch (e) { console.log("RyanWow rest move error", e); }
    }

    // --- UI: Matrix-styled draggable window ---
    function createGUI() {
        // if exists, remove
        const existing = document.getElementById("ryanwow-gui");
        if (existing) existing.remove();

        const container = document.createElement("div");
        container.id = "ryanwow-gui";
        container.style.position = "fixed";
        container.style.right = "18px";
        container.style.top = "80px";
        container.style.zIndex = 9999999;
        container.style.width = "360px";
        container.style.maxWidth = "90vw";
        container.style.background = "rgba(5,7,6,0.92)";
        container.style.border = `1px solid ${themeColor}`;
        container.style.borderRadius = "10px";
        container.style.color = "#bfffbf";
        container.style.fontFamily = "monospace";
        container.style.boxShadow = "0 10px 30px rgba(0,0,0,0.6)";
        container.style.userSelect = "none";
        container.style.backdropFilter = "blur(4px)";

        // header
        const header = document.createElement("div");
        header.style.padding = "10px";
        header.style.display = "flex";
        header.style.alignItems = "center";
        header.style.justifyContent = "space-between";

        const title = document.createElement("div");
        title.innerText = "RYANWOW";
        title.style.fontWeight = "700";
        title.style.letterSpacing = "1px";
        title.style.color = themeColor;
        title.style.fontSize = "13px";

        const controls = document.createElement("div");
        controls.style.display = "flex";
        controls.style.gap = "8px";

        // minimize button
        const btnMin = document.createElement("button");
        btnMin.innerText = "—";
        styleSmallButton(btnMin);
        btnMin.onclick = () => {
            const body = container.querySelector(".ryanwow-body");
            if (body) body.style.display = body.style.display === "none" ? "block" : "none";
        };

        // close button (only hides)
        const btnClose = document.createElement("button");
        btnClose.innerText = "×";
        styleSmallButton(btnClose);
        btnClose.onclick = () => { container.style.display = "none"; };

        controls.appendChild(btnMin);
        controls.appendChild(btnClose);

        header.appendChild(title);
        header.appendChild(controls);

        // body
        const body = document.createElement("div");
        body.className = "ryanwow-body";
        body.style.padding = "10px";
        body.style.display = "block";

        // matrix canvas (bg)
        const canvasWrap = document.createElement("div");
        canvasWrap.style.width = "100%";
        canvasWrap.style.height = "90px";
        canvasWrap.style.overflow = "hidden";
        canvasWrap.style.borderRadius = "6px";
        canvasWrap.style.marginBottom = "8px";
        canvasWrap.style.background = "#000";
        canvasWrap.style.position = "relative";

        const canvas = document.createElement("canvas");
        canvas.width = 800;
        canvas.height = 90;
        canvas.style.width = "100%";
        canvas.style.height = "90px";
        canvasWrap.appendChild(canvas);
        runMatrix(canvas, themeColor);

        // controls grid
        const grid = document.createElement("div");
        grid.style.display = "grid";
        grid.style.gridTemplateColumns = "1fr 1fr";
        grid.style.gap = "8px";

        // buttons
        const btnAuto = createToggleButton("Auto Return", autoReturn, v => { autoReturn = v; saveSettings(); });
        const btnDM = createToggleButton("Send DM", sendDM, v => { sendDM = v; saveSettings(); });
        const btnSound = createToggleButton("Sound", playSoundOnPull, v => { playSoundOnPull = v; saveSettings(); });
        const btnUltra = createToggleButton("Ultra Protect", ultraProtect, v => { ultraProtect = v; saveSettings(); });

        grid.appendChild(btnAuto);
        grid.appendChild(btnDM);
        grid.appendChild(btnSound);
        grid.appendChild(btnUltra);

        // Quick actions row
        const actions = document.createElement("div");
        actions.style.display = "flex";
        actions.style.gap = "8px";
        actions.style.marginTop = "8px";

        const btnReturnNow = document.createElement("button");
        btnReturnNow.innerText = "Return Now";
        styleActionButton(btnReturnNow);
        btnReturnNow.onclick = () => {
            if (lastChannel) {
                if (tryJoinChannel(lastChannel)) toast("Returned to channel");
                else toast("Cannot return (API missing)");
            } else toast("No saved channel to return to");
        };

        const btnOpenLog = document.createElement("button");
        btnOpenLog.innerText = "Open Log";
        styleActionButton(btnOpenLog);
        btnOpenLog.onclick = () => {
            const lg = container.querySelector(".ryanwow-log");
            if (lg) lg.style.display = lg.style.display === "none" ? "block" : "none";
        };

        actions.appendChild(btnReturnNow);
        actions.appendChild(btnOpenLog);

        // color picker and font size
        const toolsRow = document.createElement("div");
        toolsRow.style.display = "flex";
        toolsRow.style.gap = "8px";
        toolsRow.style.marginTop = "8px";
        toolsRow.style.alignItems = "center";

        const colorLabel = document.createElement("label");
        colorLabel.innerText = "Theme";
        colorLabel.style.fontSize = "12px";
        colorLabel.style.marginRight = "6px";

        const colorInput = document.createElement("input");
        colorInput.type = "color";
        colorInput.value = themeColor;
        colorInput.onchange = (e) => {
            themeColor = e.target.value;
            saveSettings();
            // update border & title
            container.style.border = `1px solid ${themeColor}`;
            title.style.color = themeColor;
        };

        const fontSizeInput = document.createElement("input");
        fontSizeInput.type = "range";
        fontSizeInput.min = 11;
        fontSizeInput.max = 18;
        fontSizeInput.value = 13;
        fontSizeInput.oninput = (e) => {
            const v = e.target.value;
            container.style.fontSize = v + "px";
        };

        toolsRow.appendChild(colorLabel);
        toolsRow.appendChild(colorInput);
        toolsRow.appendChild(document.createTextNode("Font"));
        toolsRow.appendChild(fontSizeInput);

        // log area
        const logWrap = document.createElement("div");
        logWrap.className = "ryanwow-log";
        logWrap.style.marginTop = "8px";
        logWrap.style.maxHeight = "120px";
        logWrap.style.overflow = "auto";
        logWrap.style.background = "rgba(0,0,0,0.45)";
        logWrap.style.border = `1px solid rgba(255,255,255,0.03)`;
        logWrap.style.padding = "8px";
        logWrap.style.borderRadius = "6px";

        // render log placeholder
        const logInner = document.createElement("div");
        logInner.id = "ryanwow-log-inner";
        logInner.style.fontSize = "12px";
        logInner.style.lineHeight = "1.4";
        logWrap.appendChild(logInner);

        // footer small text
        const footer = document.createElement("div");
        footer.style.fontSize = "11px";
        footer.style.opacity = "0.8";
        footer.style.marginTop = "8px";
        footer.innerText = "RyanWow • Matrix UI • v1.0";

        body.appendChild(canvasWrap);
        body.appendChild(grid);
        body.appendChild(actions);
        body.appendChild(toolsRow);
        body.appendChild(logWrap);
        body.appendChild(footer);

        container.appendChild(header);
        container.appendChild(body);

        // make draggable
        makeDraggable(container, header);

        // append to body
        document.body.appendChild(container);

        gui = container;
        renderLog();
    }

    function styleSmallButton(btn) {
        btn.style.background = "transparent";
        btn.style.border = "1px solid rgba(255,255,255,0.03)";
        btn.style.color = themeColor;
        btn.style.padding = "4px 8px";
        btn.style.borderRadius = "6px";
        btn.style.cursor = "pointer";
        btn.onmouseenter = () => btn.style.transform = "translateY(-1px)";
        btn.onmouseleave = () => btn.style.transform = "translateY(0)";
    }

    function styleActionButton(btn) {
        btn.style.background = themeColor;
        btn.style.color = "#001000";
        btn.style.border = "none";
        btn.style.padding = "6px 10px";
        btn.style.borderRadius = "6px";
        btn.style.cursor = "pointer";
        btn.onmouseenter = () => btn.style.filter = "brightness(1.05)";
        btn.onmouseleave = () => btn.style.filter = "brightness(1)";
    }

    function createToggleButton(label, initial, onChange) {
        const wrap = document.createElement("div");
        wrap.style.display = "flex";
        wrap.style.justifyContent = "space-between";
        wrap.style.alignItems = "center";
        wrap.style.padding = "6px 8px";
        wrap.style.background = "rgba(0,0,0,0.2)";
        wrap.style.borderRadius = "6px";

        const lab = document.createElement("div");
        lab.innerText = label;
        lab.style.fontSize = "12px";

        const chk = document.createElement("input");
        chk.type = "checkbox";
        chk.checked = initial;
        chk.onchange = (e) => {
            onChange(e.target.checked);
            safeLog({ time: nowStr(), userId: myId || "me", userName: "System", action: `${label} = ${e.target.checked}` });
        };

        wrap.appendChild(lab);
        wrap.appendChild(chk);
        return wrap;
    }

    function runMatrix(canvas, color) {
        try {
            const ctx = canvas.getContext("2d");
            const w = canvas.width;
            const h = canvas.height;
            const fontSize = 12;
            const cols = Math.floor(w / fontSize);
            const ypos = Array(cols).fill(0);

            function matrixFrame() {
                ctx.fillStyle = "rgba(0,0,0,0.08)";
                ctx.fillRect(0, 0, w, h);

                ctx.fillStyle = color || "#00ff44";
                ctx.font = fontSize + "px monospace";

                for (let i = 0; i < ypos.length; i++) {
                    const text = String.fromCharCode(0x30A0 + Math.random() * 96);
                    ctx.fillText(text, i * fontSize, ypos[i] * fontSize);

                    if (ypos[i] * fontSize > h && Math.random() > 0.975) ypos[i] = 0;
                    ypos[i]++;
                }

                requestAnimationFrame(matrixFrame);
            }
            matrixFrame();
        } catch (e) { /* ignore if canvas unavailable */ }
    }

    function makeDraggable(el, handle) {
        handle.style.cursor = "move";
        let offsetX = 0, offsetY = 0, down = false;
        handle.addEventListener("mousedown", (e) => {
            down = true;
            offsetX = e.clientX - el.getBoundingClientRect().left;
            offsetY = e.clientY - el.getBoundingClientRect().top;
            document.body.style.userSelect = "none";
        });
        window.addEventListener("mousemove", (e) => {
            if (!down) return;
            el.style.left = (e.clientX - offsetX) + "px";
            el.style.top = (e.clientY - offsetY) + "px";
            el.style.right = "auto";
        });
        window.addEventListener("mouseup", () => { down = false; document.body.style.userSelect = ""; });
    }

    function renderLog() {
        if (!gui) return;
        const inner = document.getElementById("ryanwow-log-inner");
        if (!inner) return;
        inner.innerHTML = "";
        for (let i = 0; i < Math.min(60, log.length); i++) {
            const it = log[i];
            const p = document.createElement("div");
            p.style.padding = "2px 0";
            p.style.borderBottom = "1px dashed rgba(255,255,255,0.02)";
            p.innerText = `[${it.time}] ${it.action} ${it.userName ? `- ${it.userName}` : ""}`;
            inner.appendChild(p);
        }
    }

    function saveSettings() {
        try {
            localStorage.setItem("ryanwow_settings", JSON.stringify({
                autoReturn, sendDM, playSoundOnPull, ultraProtect, themeColor, log
            }));
        } catch (e) { /* ignore */ }
    }
    function loadSettings() {
        try {
            const s = JSON.parse(localStorage.getItem("ryanwow_settings") || "{}");
            if (typeof s.autoReturn === "boolean") autoReturn = s.autoReturn;
            if (typeof s.sendDM === "boolean") sendDM = s.sendDM;
            if (typeof s.playSoundOnPull === "boolean") playSoundOnPull = s.playSoundOnPull;
            if (typeof s.ultraProtect === "boolean") ultraProtect = s.ultraProtect;
            if (typeof s.themeColor === "string") themeColor = s.themeColor;
            if (Array.isArray(s.log)) log = s.log;
        } catch (e) { /* ignore */ }
    }

    // --- Core logic: handle voice state updates & pull detection ---
    function onVoiceStateUpdates(payload) {
        try {
            const voiceStates = payload.voiceStates || payload;
            if (!voiceStates || !Array.isArray(voiceStates)) return;

            if (!myId) myId = UserStore?.getCurrentUser?.()?.id || myId;

            for (const state of voiceStates) {
                // if update about me
                if (state.userId === myId) {
                    const newChannel = state.channelId || null;
                    if (newChannel && newChannel !== lastChannel) {
                        // moved/joined new channel
                        lastChannel = newChannel;
                        safeLog({ time: nowStr(), userId: myId, userName: "You", action: "Joined channel " + newChannel });
                    } else if (!newChannel && lastChannel) {
                        // we were removed/kicked
                        safeLog({ time: nowStr(), userId: myId, userName: "You", action: "Removed from channel (attempting return)" });
                        toast("You were removed — attempting return...");
                        playPing();

                        // immediate local join attempt
                        if (autoReturn && lastChannel) {
                            const ok = tryJoinChannel(lastChannel);
                            if (!ok && ultraProtect) {
                                // Try REST move if we have REST access
                                // Find guild id via ChannelStore if available
                                const ChannelStore = V.Api?.ChannelStore || V.ChannelStore;
                                const channel = ChannelStore?.getChannel?.(lastChannel);
                                const guildId = channel?.guild_id;
                                if (guildId) restMoveMember(guildId, myId, lastChannel);
                            }
                        }
                    }
                } else {
                    // update about someone else -> detect if they tried to pull you
                    // when someone initiates moving, there may be a state where your userId remains same but the mover triggers a change
                    const movedBy = state.userId;
                    const movedTo = state.channelId || null;
                    if (lastChannel && movedTo && movedTo !== lastChannel) {
                        // He moved to some other channel; check if this is an attempt related to you:
                        // We look for when other user's action immediately preceded your removal in logs - best-effort
                        safeLog({ time: nowStr(), userId: movedBy, userName: (UserStore.getUser ? UserStore.getUser(movedBy)?.username : movedBy), action: `User moved to ${movedTo}` });

                        // If ultraProtect and sendDM is true, message them
                        if (sendDM) {
                            try {
                                const name = (UserStore.getUser ? UserStore.getUser(movedBy)?.username : movedBy) || movedBy;
                                sendDMToUser(movedBy, `⚠️ You moved to a channel — RyanWow detected movement by ${name}. Please do not pull users.`);
                                safeLog({ time: nowStr(), userId: movedBy, userName: name, action: "Sent DM to mover" });
                            } catch (e) {
                                console.log("RyanWow DM fail", e);
                            }
                        }
                    }
                }
            }
        } catch (e) { console.log("RyanWow update error", e); }
    }

    // attach flux watcher + periodic monitor
    function startMonitoring() {
        if (fluxToken || monitoringInterval) return;
        if (FluxDispatcher && FluxDispatcher.subscribe) {
            fluxToken = FluxDispatcher.subscribe("VOICE_STATE_UPDATES", onVoiceStateUpdates);
        }
        // fallback monitor - poll every 1200ms (best-effort)
        monitoringInterval = setInterval(() => {
            try {
                const ChannelStore = V.Api?.ChannelStore || V.ChannelStore;
                const states = V.Api?.VoiceStateStore?.getAllVoiceStates?.() || (V.VoiceStateStore && V.VoiceStateStore.getAllVoiceStates && V.VoiceStateStore.getAllVoiceStates()) || {};
                // try to detect current user channel
                const me = UserStore?.getCurrentUser?.();
                if (!me) return;
                const meId = me.id;
                for (const guildStates of Object.values(states)) {
                    if (guildStates[meId] && guildStates[meId].channelId) {
                        const c = guildStates[meId].channelId;
                        if (!lastChannel) lastChannel = c;
                        break;
                    }
                }
            } catch (e) { /* ignore */ }
        }, 1200);
    }

    function stopMonitoring() {
        try {
            if (fluxToken && FluxDispatcher && FluxDispatcher.unsubscribe) {
                FluxDispatcher.unsubscribe(fluxToken);
                fluxToken = null;
            }
            if (monitoringInterval) {
                clearInterval(monitoringInterval);
                monitoringInterval = null;
            }
        } catch (e) { /* ignore */ }
    }

    // --- Plugin start / stop (User Plugin style) ---
    const plugin = {
        name: PLUGIN_NAME,
        description: "RyanWow — Ultimate protection + Matrix GUI",
        authors: [{ name: "Ryan" }],

        start() {
            try {
                myId = UserStore?.getCurrentUser?.()?.id || myId;
                loadSettings();
                createGUI();
                createQuickButton();
                startMonitoring();
                toast("RyanWow loaded");
                safeLog({ time: nowStr(), userId: myId || "me", userName: "System", action: "Plugin started" });
            } catch (e) { console.log("RyanWow start error", e); }
        },

        stop() {
            try {
                stopMonitoring();
                const existing = document.getElementById("ryanwow-gui");
                if (existing) existing.remove();
                const btn = document.getElementById("ryanwow-quickbtn");
                if (btn) btn.remove();
                window.__RYANWOW_PLUGIN_LOADED__ = false;
                toast("RyanWow stopped");
                safeLog({ time: nowStr(), userId: myId || "me", userName: "System", action: "Plugin stopped" });
            } catch (e) { console.log("RyanWow stop error", e); }
        }
    };

    // quick floating button
    function createQuickButton() {
        const existing = document.getElementById("ryanwow-quickbtn");
        if (existing) return;
        const b = document.createElement("button");
        b.id = "ryanwow-quickbtn";
        b.innerText = "⤴ Ryan";
        b.style.position = "fixed";
        b.style.right = "12px";
        b.style.bottom = "18px";
        b.style.zIndex = 9999998;
        b.style.padding = "8px 12px";
        b.style.borderRadius = "999px";
        b.style.border = "none";
        b.style.cursor = "pointer";
        b.style.background = themeColor;
        b.style.color = "#001000";
        b.onclick = () => {
            if (lastChannel) {
                const ok = tryJoinChannel(lastChannel);
                if (ok) toast("Returned to saved channel");
                else toast("Cannot return (API missing)");
            } else toast("No saved channel");
        };
        document.body.appendChild(b);
        quickBtn = b;
    }

    // Expose plugin object for UserPlugins loader
    try {
        module.exports = plugin;
    } catch (e) {
        // if module pattern not allowed, attach to window
        window.RyanWow = plugin;
    }
})();
