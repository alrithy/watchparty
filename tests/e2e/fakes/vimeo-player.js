// Stand-in for https://player.vimeo.com/api/player.js in browser tests (the
// sandbox can't reach Vimeo). Backed by the test clip. Rate changes are refused,
// like on basic Vimeo accounts, so the seek-only drift path is exercised.
// A URL containing "999999999" behaves like a private video.
(function () {
  function Player(el, opts) {
    var handlers = {};
    var v = document.createElement("video");
    v.dataset.testid = "video";
    v.dataset.fake = "vimeo";
    v.className = "h-full w-full";
    v.playsInline = true;
    v.preload = "auto";
    v.src = "/__test__/clip.webm";
    el.appendChild(v);
    var priv = String(opts.url || opts.id).indexOf("999999999") >= 0;
    function emit(name, data) {
      (handlers[name] || []).forEach(function (cb) { cb(data); });
    }
    var readyPromise = new Promise(function (resolve, reject) {
      if (priv) {
        setTimeout(function () {
          emit("error", { name: "PrivacyError", message: "private" });
          reject({ name: "PrivacyError" });
        }, 50);
        return;
      }
      v.addEventListener("loadedmetadata", function () {
        resolve();
        emit("loaded", { id: 1 });
      });
    });
    var info = function () { return { seconds: v.currentTime, duration: v.duration, percent: 0 }; };
    v.addEventListener("play", function () { emit("play", info()); });
    v.addEventListener("playing", function () { emit("playing", info()); });
    v.addEventListener("pause", function () { emit("pause", info()); });
    v.addEventListener("seeked", function () { emit("seeked", info()); });
    v.addEventListener("timeupdate", function () { emit("timeupdate", info()); });
    v.addEventListener("waiting", function () { emit("bufferstart"); });
    v.addEventListener("canplay", function () { emit("bufferend"); });
    v.addEventListener("ended", function () { emit("ended", info()); });
    this.on = function (name, cb) { (handlers[name] = handlers[name] || []).push(cb); };
    this.ready = function () { return readyPromise; };
    this.play = function () { return v.play(); };
    this.pause = function () { v.pause(); return Promise.resolve(); };
    this.setCurrentTime = function (s) { v.currentTime = s; return Promise.resolve(s); };
    this.getCurrentTime = function () { return Promise.resolve(v.currentTime); };
    this.getDuration = function () { return Promise.resolve(v.duration || 0); };
    this.setPlaybackRate = function () { return Promise.reject({ name: "Error", message: "rate not available" }); };
    this.setVolume = function (n) { v.volume = n; return Promise.resolve(n); };
    this.setMuted = function (m) { v.muted = m; return Promise.resolve(m); };
    this.destroy = function () { v.removeAttribute("src"); v.load(); v.remove(); return Promise.resolve(); };
  }
  window.Vimeo = { Player: Player };
})();
