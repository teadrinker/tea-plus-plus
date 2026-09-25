// Shared browser-side glue for wasm modules built against
// platform/platform_wasm.c's w_* exports (canvas pixel blit, pointer/
// keyboard/clipboard bridging). Used by the full-page harness
// (platform_wasm.html) and by anything embedding a wasm-driven canvas inside
// a larger page (e.g. Mad Tea Lab's VM section, mad-tea-lab-vm.js) -- both
// load this module instead of re-implementing the glue.

const wasmCache = new Map(); // url -> Promise<exports>

// Fetch + instantiate once per URL (repeat calls resolve the same instance).
export function loadWasm(url) {
    if (!wasmCache.has(url)) {
        wasmCache.set(url, (async () => {
            const resp = await fetch(url);
            if (!resp.ok) throw new Error("fetch " + url + ": " + resp.status);
            const bytes = await resp.arrayBuffer();
            let memory = null;
            const { instance } = await WebAssembly.instantiate(bytes, { env: {
                js_time_ms: () => performance.now(),   // platform_time_seconds
                js_get_arg: (namePtr, dstLen, dstPtr) => getArg(memory, namePtr, dstLen, dstPtr),   // platform_get_arg
            } });
            memory = instance.exports.memory;
            const wasm = instance.exports;
            wasm.w_init();
            return wasm;
        })());
    }
    return wasmCache.get(url);
}

// ?name=value from the page URL, UTF-8 into dst (truncated, null-terminated).
function getArg(memory, namePtr, dstLen, dstPtr) {
    const bytes = new Uint8Array(memory.buffer);
    let end = namePtr;
    while (bytes[end] !== 0) end++;
    const value = new URLSearchParams(location.search).get(new TextDecoder().decode(bytes.subarray(namePtr, end)));
    if (value === null) return 0;
    if (dstLen > 0) {
        const n = new TextEncoder().encodeInto(value, bytes.subarray(dstPtr, dstPtr + dstLen - 1)).written;
        bytes[dstPtr + n] = 0;
    }
    return 1;
}

function readWasmStr(wasm, ptr) {
    if (!ptr) return '';
    const mem = new Uint8Array(wasm.memory.buffer);
    let end = ptr;
    while (end < mem.length && mem[end] !== 0) end++;
    return new TextDecoder().decode(mem.subarray(ptr, end));
}

// Mount `wasm` onto `canvas`: starts the render loop and wires pointer/
// keyboard/clipboard input. This owns ALL device-pixel-ratio, canvas-sizing
// and mouse-coordinate handling, so callers never deal with dpr themselves.
//
//   opts.host: an element to embed the canvas in. The canvas is sized to the
//     host's content box and kept in sync as the host resizes (ResizeObserver)
//     and as the page is zoomed. Implies non-fullscreen. Pointer coordinates
//     are mapped into the canvas automatically. This is the reusable path for
//     embedding a wasm canvas inside a larger page (e.g. Mad Tea Lab's VM).
//   opts.fullscreen (default true, unless opts.host is given): size the canvas
//     to the browser window and track window resize + zoom.
//   opts.keyTarget: EventTarget to listen for keydown on (default: `window`
//     when fullscreen, else `canvas` itself -- e.g. give the canvas
//     tabIndex=0 so it can be focused and won't steal keys page-wide).
//   opts.onFrame(wasm): called after every w_frame() call (whether or not
//     the pixel buffer changed), so callers can piggyback per-frame polling
//     without a second requestAnimationFrame loop.
//
// In every managed mode the backing store is sized to CSS-pixels *
// devicePixelRatio, so rendering is crisp on high-density displays and when
// zoomed (a true high-dpi canvas). w_set_dpi(dpr) is reported to the module,
// but a module that ignores it (like the ui_demo / VM textmode renderer) draws
// at a fixed device-pixel size -- i.e. a constant physical size across zoom.
//
// Returns { resize(w,h), destroy() }. resize(w,h) only matters for the rare
// caller that supplies neither host nor fullscreen (it then owns sizing and
// passes device-pixel dimensions); host/fullscreen modes self-manage.
export function attachCanvas(canvas, wasm, opts) {
    opts = opts || {};
    const host = opts.host || null;
    const fullscreen = host ? false : (opts.fullscreen !== false);
    const keyTarget = opts.keyTarget || (fullscreen ? window : canvas);
    const onFrame = opts.onFrame || (() => {});

    const ctx = canvas.getContext("2d");
    let dpr = window.devicePixelRatio || 1;
    let oomReported = false;
    let running = true;
    let rafHandle = 0;

    function checkOOM() {
        if (wasm.alloc_oom && wasm.alloc_oom() && !oomReported) {
            oomReported = true;
            const stats = wasm.alloc_stats ? readWasmStr(wasm, wasm.alloc_stats()) : 'alloc_stats not available';
            console.warn('WASM allocator OOM: ' + stats);
        }
    }

    // Sizes the backing store to device pixels and keeps the CSS box matched so
    // the bitmap maps exactly 1:1 onto device pixels -- no browser resampling
    // (which would blur), and exact pointer mapping. The CSS size comes from the
    // window (fullscreen), the host element (embedded), or the explicit w/h
    // args (unmanaged caller, treated as final device pixels).
    //
    // style.width/height is always derived back from the *rounded* backing-store
    // size (canvas.width / dpr), never set independently (e.g. to "100%"): when
    // cssW*dpr isn't an integer (most zoom levels, since dpr = browser-zoom * OS
    // scale) a fixed CSS box mismatches the rounded backing store by a fraction
    // of a pixel, and the browser stretches the bitmap to fill it -- blur, plus
    // a pointer offset that grows with distance from the origin.
    function resize(w, h) {
        dpr = window.devicePixelRatio || 1;
        let cssW = null, cssH = null;
        if (fullscreen)   { cssW = window.innerWidth; cssH = window.innerHeight; }
        else if (host)    { cssW = host.clientWidth;  cssH = host.clientHeight; }
        if (cssW !== null) { w = cssW * dpr; h = cssH * dpr; }
        canvas.width  = Math.max(1, Math.floor(w));
        canvas.height = Math.max(1, Math.floor(h));
        canvas.style.width  = (canvas.width  / dpr) + "px";
        canvas.style.height = (canvas.height / dpr) + "px";
        if (wasm.w_set_dpi) wasm.w_set_dpi(dpr);
    }

    // matchMedia add/remove that also tolerates the old Safari listener API.
    function mqlOn(m, fn)  { m.addEventListener    ? m.addEventListener("change", fn)    : m.addListener(fn); }
    function mqlOff(m, fn) { m.removeEventListener ? m.removeEventListener("change", fn) : m.removeListener(fn); }

    // devicePixelRatio changes on browser zoom / moving the window to a
    // differently-scaled display, and there's no dedicated event for it. The
    // standard workaround is a resolution-scoped matchMedia query that fires
    // once when the ratio leaves the value it was armed at; we then re-sync the
    // canvas and re-arm at the new ratio. Needed in every managed mode -- a zoom
    // change must be caught even when the host's CSS size hasn't changed.
    let mql = null;
    const onDprChange = () => { resize(); armDprWatch(); };
    function armDprWatch() {
        if (mql) mqlOff(mql, onDprChange);
        if (typeof window.matchMedia !== "function") { mql = null; return; }
        mql = window.matchMedia("(resolution: " + dpr + "dppx)");
        mqlOn(mql, onDprChange);
    }

    const onWindowResize = () => resize();
    let resizeObserver = null;
    if (fullscreen) {
        window.addEventListener("resize", onWindowResize);
    } else if (host && typeof ResizeObserver !== "undefined") {
        resizeObserver = new ResizeObserver(() => resize());
        resizeObserver.observe(host);
    }
    // Size the canvas once, synchronously, before the first frame (avoids a
    // one-frame flash at the default 300x150), and start watching dpr.
    if (fullscreen || host) { resize(); armDprWatch(); }

    function frame(now) {
        if (!running) return;
        const w = canvas.width, h = canvas.height;
        if (w > 0 && h > 0) {
            const outPtr = wasm.w_frame(now / 1000.0, w, h);
            if (outPtr) {
                if (!(wasm.w_frame_result() & 16 /* EACH_FRAME_RETURN_ARGB_UNCHANGED */)) {
                    const pixels = new Uint8ClampedArray(wasm.memory.buffer, outPtr, w * h * 4);
                    ctx.putImageData(new ImageData(pixels, w, h), 0, 0);
                }
                checkOOM();
            }
        }
        onFrame(wasm);
        rafHandle = requestAnimationFrame(frame);
    }
    rafHandle = requestAnimationFrame(frame);

    // ---- pointer / wheel ----
    // Map a pointer event's canvas-relative CSS offset into backing-store
    // (device) pixels -- the space w_frame() renders and w_mouse() expects.
    // Uses the live backing/CSS ratio rather than dpr directly, so it stays
    // exact regardless of dpr, zoom, or sub-pixel rounding of the CSS box, and
    // needs no dpr bookkeeping on the caller's side. offsetX/Y are relative to
    // the canvas padding box (the canvas carries no padding/border here).
    const mapX = e => e.offsetX * (canvas.clientWidth  ? canvas.width  / canvas.clientWidth  : dpr);
    const mapY = e => e.offsetY * (canvas.clientHeight ? canvas.height / canvas.clientHeight : dpr);

    let lastDownTime = 0, lastDownX = 0, lastDownY = 0;
    const onPointerDown = e => {
        // Embedded (non-fullscreen) canvases are given tabIndex so they can
        // take keyboard focus like any other widget on the host page -- a
        // click should claim it, same as clicking into a textarea would.
        canvas.focus();
        const now = performance.now();
        const dx = e.offsetX - lastDownX, dy = e.offsetY - lastDownY;
        const doubleClick = (now - lastDownTime < 300) && e.button === 0 && Math.sqrt(dx * dx + dy * dy) <= 5 ? 1 : 0;
        lastDownTime = now; lastDownX = e.offsetX; lastDownY = e.offsetY;
        const flags = (e.ctrlKey ? 2 : 0) | (e.shiftKey ? 4 : 0) | (e.altKey ? 8 : 0) | doubleClick;
        wasm.w_mouse(mapX(e), mapY(e), 0.0, 1, e.button, flags);
        canvas.setPointerCapture(e.pointerId);
    };
    const onPointerUp = e => {
        const flags = (e.ctrlKey ? 2 : 0) | (e.shiftKey ? 4 : 0) | (e.altKey ? 8 : 0);
        wasm.w_mouse(mapX(e), mapY(e), 0.0, 2, e.button, flags);
    };
    const onPointerMove = e => {
        const flags = (e.ctrlKey ? 2 : 0) | (e.shiftKey ? 4 : 0) | (e.altKey ? 8 : 0);
        const mxv = mapX(e), myv = mapY(e);
        if (e.buttons & 1)      wasm.w_mouse(mxv, myv, 0.0, 3, 0, flags);
        else if (e.buttons & 4) wasm.w_mouse(mxv, myv, 0.0, 3, 1, flags);
        else if (e.buttons & 2) wasm.w_mouse(mxv, myv, 0.0, 3, 2, flags);
        else                    wasm.w_mouse(mxv, myv, 0.0, 0, -1, flags);
    };
    // Wheel deltas come in wildly different units: a mouse notch is a single
    // coarse event (~100px in Chrome/Safari, 3 "lines" in Firefox), while a
    // trackpad streams dozens of small pixel deltas per gesture. Quantising
    // every event to +/-1 notch therefore made the trackpad scroll roughly an
    // order of magnitude too fast, so report fractional notches instead -- the
    // C side accumulates sub-notch wheel values (see textmode_ui_textarea.c).
    const WHEEL_PIXELS_PER_NOTCH = 100.0; // deltaMode 0, Chrome/Safari mouse notch
    const WHEEL_LINES_PER_NOTCH  = 3.0;   // deltaMode 1, Firefox mouse notch
    const WHEEL_NOTCHES_PER_PAGE = 3.0;   // deltaMode 2, rare
    const WHEEL_MAX_NOTCHES      = 3.0;   // per event, so momentum spikes can't fling
    const onWheel = e => {
        const flags = (e.ctrlKey ? 2 : 0) | (e.shiftKey ? 4 : 0) | (e.altKey ? 8 : 0);
        let notches;
        if (e.deltaMode === 1)      notches = e.deltaY / WHEEL_LINES_PER_NOTCH;
        else if (e.deltaMode === 2) notches = e.deltaY * WHEEL_NOTCHES_PER_PAGE;
        else                        notches = e.deltaY / WHEEL_PIXELS_PER_NOTCH;
        notches = Math.max(-WHEEL_MAX_NOTCHES, Math.min(WHEEL_MAX_NOTCHES, notches));
        // Wheel is positive when scrolling up; deltaY is positive going down.
        wasm.w_mouse(mapX(e), mapY(e), -notches, 4, -1, flags);
        e.preventDefault();
    };
    const onContextMenu = e => e.preventDefault();

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("wheel", onWheel);
    canvas.addEventListener("contextmenu", onContextMenu);

    // ---- keyboard + clipboard ----
    // JS keycodes loosely match Win32 for basic navigation keys.
    const keyMap = {
        "ArrowLeft": 0x25, "ArrowUp": 0x26, "ArrowRight": 0x27, "ArrowDown": 0x28,
        "Home": 0x24, "End": 0x23, "PageUp": 0x21, "PageDown": 0x22,
        "Delete": 0x2E, "Backspace": 0x08, "Escape": 0x1B,
        "Enter": 0x0D, "Tab": 0x09
    };

    // After a Ctrl+C/X key, if WASM wrote copy-text, push it to the browser clipboard.
    function flushCopyToBrowser() {
        if (!wasm.w_is_clipboard_dirty || !wasm.w_get_clipboard_text) return;
        if (!wasm.w_is_clipboard_dirty()) return;
        const text = readWasmStr(wasm, wasm.w_get_clipboard_text());
        if (!text) return;
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).catch(() => {});
        } else {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed'; ta.style.left = '-9999px';
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy'); } catch (e) {}
            document.body.removeChild(ta);
        }
    }

    // Write text into the WASM paste buffer and inject Ctrl+V.
    function injectPaste(text) {
        if (!wasm.w_get_paste_buffer) return;
        const pastePtr = wasm.w_get_paste_buffer();
        const cap = wasm.w_get_paste_buffer_cap ? wasm.w_get_paste_buffer_cap() : 65536;
        const maxLen = cap - 1; // leave room for null terminator
        const pasteBuf = new Uint8Array(wasm.memory.buffer, pastePtr, cap);
        if (text) {
            const encoded = new TextEncoder().encode(text);
            const len = Math.min(encoded.length, maxLen);
            pasteBuf.set(encoded.subarray(0, len));
            pasteBuf[len] = 0;
        } else {
            pasteBuf[0] = 0;
        }
        wasm.w_key(86 /* 'V' */, 1, 2 /* FLAGS_CTRL */);
    }

    const onKeyDown = e => {
        const flags = (e.ctrlKey ? 2 : 0) | (e.shiftKey ? 4 : 0) | (e.altKey ? 8 : 0);
        if (keyMap[e.key]) {
            wasm.w_key(keyMap[e.key], 1, flags);
            e.preventDefault();
        } else if (e.key.length === 1 && e.ctrlKey) {
            const upper = e.key.toUpperCase();
            if (upper === 'V') {
                // Read from the system clipboard (async, needs the user gesture we have here).
                e.preventDefault();
                if (navigator.clipboard && navigator.clipboard.readText) {
                    navigator.clipboard.readText().then(injectPaste).catch(() => injectPaste(''));
                } else {
                    injectPaste('');
                }
                return;
            }
            // Ctrl+C, Ctrl+X
            wasm.w_key(upper.charCodeAt(0), 1, flags);
            setTimeout(flushCopyToBrowser, 0);
            e.preventDefault();
        } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
            wasm.w_char(e.key.charCodeAt(0), flags);
            e.preventDefault();
        }
    };
    keyTarget.addEventListener("keydown", onKeyDown);

    function destroy() {
        running = false;
        if (rafHandle) cancelAnimationFrame(rafHandle);
        rafHandle = 0;
        if (fullscreen) window.removeEventListener("resize", onWindowResize);
        if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }
        if (mql) { mqlOff(mql, onDprChange); mql = null; }
        canvas.removeEventListener("pointerdown", onPointerDown);
        canvas.removeEventListener("pointerup", onPointerUp);
        canvas.removeEventListener("pointermove", onPointerMove);
        canvas.removeEventListener("wheel", onWheel);
        canvas.removeEventListener("contextmenu", onContextMenu);
        keyTarget.removeEventListener("keydown", onKeyDown);
    }

    return { resize, destroy };
}
