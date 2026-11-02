/* Embed on any page:  <script src="https://YOUR-SERVICE.onrender.com/widget.js" defer></script> */
(function () {
  var base = (document.currentScript && document.currentScript.src || '').replace(/\/widget\.js.*$/, '');
  var btn = document.createElement('button');
  btn.setAttribute('aria-label', 'Open support chat');
  btn.innerHTML = '\u{1F4AC}';
  btn.style.cssText = 'position:fixed;right:20px;bottom:20px;width:58px;height:58px;border-radius:50%;border:0;background:#2f6bff;color:#fff;font-size:26px;cursor:pointer;z-index:2147483000;box-shadow:0 8px 24px rgba(0,0,0,.4)';
  var frame = document.createElement('iframe');
  frame.allow = 'microphone; autoplay';
  frame.style.cssText = 'position:fixed;right:20px;bottom:92px;width:min(400px,calc(100vw - 24px));height:min(640px,calc(100vh - 110px));border:1px solid #17224a;border-radius:16px;display:none;z-index:2147483000;box-shadow:0 12px 40px rgba(0,0,0,.5);background:#050a1a';
  btn.onclick = function () {
    if (!frame.src) frame.src = base + '/?embed=1';
    frame.style.display = frame.style.display === 'none' ? 'block' : 'none';
  };
  document.body.appendChild(frame); document.body.appendChild(btn);
})();
