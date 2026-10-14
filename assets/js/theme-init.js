(function () {
  try {
    var saved = localStorage.getItem("bootstrap-template-theme");
    if (saved) document.documentElement.setAttribute("data-theme", saved);
  } catch (e) {}
})();
