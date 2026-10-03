/*
 * Fenêtre de sélection de dossier Google Drive (Google Picker), exécutée dans un cadre isolé.
 * Reçoit sa configuration de la page parente (même origine) et lui renvoie le dossier choisi.
 */
(function () {
  "use strict";
  var origin = window.location.origin;

  function reply(message) {
    window.parent.postMessage(Object.assign({ type: "gu-google-picker-result" }, message), origin);
  }

  function loadPicker(callback) {
    var script = document.createElement("script");
    script.src = "https://apis.google.com/js/api.js";
    script.onerror = function () { reply({ error: "La fenêtre Google n'a pas pu être chargée." }); };
    script.onload = function () {
      window.gapi.load("picker", { callback: callback, onerror: function () { reply({ error: "La fenêtre Google n'a pas pu être chargée." }); } });
    };
    document.head.appendChild(script);
  }

  function open(config) {
    var picker = window.google.picker;
    var folders = new picker.DocsView(picker.ViewId.FOLDERS)
      .setIncludeFolders(true)
      .setSelectFolderEnabled(true)
      .setMimeTypes("application/vnd.google-apps.folder");
    var sharedDrives = new picker.DocsView(picker.ViewId.FOLDERS)
      .setIncludeFolders(true)
      .setSelectFolderEnabled(true)
      .setEnableDrives(true)
      .setMimeTypes("application/vnd.google-apps.folder");
    new picker.PickerBuilder()
      .addView(folders)
      .addView(sharedDrives)
      .enableFeature(picker.Feature.SUPPORT_DRIVES)
      .setOAuthToken(config.accessToken)
      .setDeveloperKey(config.apiKey)
      .setAppId(config.appId)
      .setOrigin(origin)
      .setLocale("fr")
      .setTitle(config.title || "Choisir un dossier")
      .setCallback(function (data) {
        var action = data[picker.Response.ACTION];
        if (action === picker.Action.PICKED) {
          var documents = data[picker.Response.DOCUMENTS] || [];
          reply({ folderId: documents[0] ? documents[0][picker.Document.ID] : null });
        } else if (action === picker.Action.CANCEL) {
          reply({ folderId: null });
        }
      })
      .build()
      .setVisible(true);
  }

  window.addEventListener("message", function (event) {
    if (event.origin !== origin || event.source !== window.parent) return;
    var data = event.data;
    if (!data || data.type !== "gu-google-picker-open") return;
    loadPicker(function () { open(data); });
  });

  reply({ ready: true });
})();
