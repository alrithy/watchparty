// Stand-in for https://www.youtube.com/iframe_api in browser tests (the sandbox
// can't reach YouTube). Same API surface the adapter uses, backed by the test clip.
// Video id "unembeddabl" behaves like a video whose owner disabled embedding.
(function () {
  function Player(el, opts) {
    var events = (opts && opts.events) || {};
    var v = document.createElement("video");
    v.dataset.testid = "video";
    v.dataset.fake = "youtube";
    v.className = "absolute inset-0 h-full w-full";
    v.playsInline = true;
    v.preload = "auto";
    v.src = "/__test__/clip.webm";
    el.replaceWith(v);
    var state = -1;
    function emit(s) {
      state = s;
      if (events.onStateChange) events.onStateChange({ data: s, target: api });
    }
    if (opts.videoId === "unembeddabl") {
      setTimeout(function () {
        if (events.onError) events.onError({ data: 150 });
      }, 50);
    }
    v.addEventListener("loadedmetadata", function () {
      // Like the real API, the player methods only exist once it is ready.
      Object.assign(shell, api);
      if (events.onReady) events.onReady({ target: api });
      emit(5);
    });
    v.addEventListener("playing", function () { emit(1); });
    v.addEventListener("pause", function () { if (!v.ended) emit(2); });
    v.addEventListener("waiting", function () { emit(3); });
    v.addEventListener("ended", function () { emit(0); });
    var api = {
      playVideo: function () { v.play().catch(function () {}); },
      pauseVideo: function () { v.pause(); },
      seekTo: function (s) {
        v.currentTime = s;
        // Like the real player: seeking from the cued/unstarted state starts playback.
        if (state === 5 || state === -1) v.play().catch(function () {});
      },
      // The real API reports position coarsely; mimic that.
      getCurrentTime: function () { return Math.floor(v.currentTime * 4) / 4; },
      getDuration: function () { return v.duration || 0; },
      getPlayerState: function () { return state; },
      setPlaybackRate: function (r) { v.playbackRate = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2].includes(r) ? r : v.playbackRate; },
      getPlaybackRate: function () { return v.playbackRate; },
      setVolume: function (n) { v.volume = n / 100; },
      mute: function () { v.muted = true; },
      unMute: function () { v.muted = false; },
      destroy: function () { v.removeAttribute("src"); v.load(); v.remove(); },
    };
    var shell = { destroy: api.destroy };
    return shell;
  }
  window.YT = { Player: Player };
  setTimeout(function () {
    if (window.onYouTubeIframeAPIReady) window.onYouTubeIframeAPIReady();
  }, 0);
})();
