/*
 * ============================================================================
 *  app.js — Lógica de «Mi fichaje»
 * ============================================================================
 *
 *  FINALIDAD
 *  Registro personal de horas de trabajo hecho por el propio trabajador. Cada
 *  entrada y cada salida es una FOTO hecha en ese momento con la cámara.
 *
 *  QUÉ OCURRE AL FICHAR
 *  1. Se pulsa el botón y se abre la cámara; se hace la foto.
 *  2. En ese instante se anota la hora y se pide la ubicación al GPS del móvil
 *     (API estándar navigator.geolocation, sin usar posiciones antiguas).
 *  3. La app graba en la propia foto una franja visible con: tipo (ENTRADA /
 *     SALIDA), fecha, hora, desfase horario, coordenadas y precisión en metros.
 *  4. Escribe los mismos datos en los metadatos EXIF estándar de la foto
 *     (fecha/hora original, latitud, longitud, precisión, hora UTC del GPS).
 *  5. Calcula la huella SHA-256 del archivo de la foto y crea un registro con
 *     todos los datos, que incluye también la huella del registro anterior
 *     (cadena de huellas). Cualquier cambio posterior en un registro o en una
 *     foto es detectable con verificar.html.
 *  6. Ofrece guardar la foto en la app Fotos del iPhone. Desde ahí se copia
 *     sola a iCloud / Google Fotos, fuera del móvil.
 *
 *  REGLAS
 *  - Solo añadir: no existe ninguna función para editar ni borrar registros.
 *  - Sin servidores: todo se procesa en el móvil; no se envía nada a nadie.
 *
 *  LIMITACIONES (declaradas expresamente)
 *  - La hora procede del reloj del móvil. La copia de la foto en iCloud /
 *    Google Fotos y los envíos por mensaje o correo aportan fechas de terceros.
 *  - La huella demuestra que nada se ha cambiado después, no la autoría por un
 *    tercero independiente.
 *
 *  Librería externa: lib/piexif.js (licencia MIT), solo para escribir EXIF.
 * ============================================================================
 */
(function () {
  "use strict";

  /* --------------------------------------------------------------------------
   *  Utilidades
   * ------------------------------------------------------------------------ */

  var LS_KEY = "fichaje.registros.v1";       // registros (texto JSON) en el móvil
  var $ = function (id) { return document.getElementById(id); };
  var records = [];      // siempre ordenados por momento (epoch) ascendente
  var idb = null;        // base de datos local de fotos (IndexedDB)
  var busy = false;      // evita dobles fichajes
  var lastBlob = null, lastRecord = null; // foto recién hecha, para guardarla

  function pad(n) { return String(n).padStart(2, "0"); }
  function fmtHM(ms) { var m = Math.round(ms / 60000); return Math.floor(m / 60) + ":" + pad(m % 60); }
  function fmtHMS(ms) { var s = Math.floor(ms / 1000); return Math.floor(s / 3600) + ":" + pad(Math.floor(s / 60) % 60) + ":" + pad(s % 60); }
  function dayKey(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  var tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  /** Desfase respecto a UTC, p. ej. "+02:00". */
  function off(d) { var o = -d.getTimezoneOffset(), a = Math.abs(o); return (o >= 0 ? "+" : "-") + pad(Math.floor(a / 60)) + ":" + pad(a % 60); }
  /** ISO 8601 en hora local con desfase, p. ej. "2026-10-22T08:00:05+02:00". */
  function localISO(d) {
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" +
      pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds()) + off(d);
  }
  function hhmm(epoch) { return new Date(epoch).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" }); }
  function esc(s) { var d = document.createElement("div"); d.textContent = s; return d.innerHTML; }
  function setMsg(t, err) { var m = $("msg"); m.textContent = t || ""; m.className = "msg" + (err ? " err" : ""); }
  function label(t) { return t === "entrada" ? "Entrada" : t === "salida" ? "Salida" : "Foto"; }

  /* --------------------------------------------------------------------------
   *  Almacenamiento en el móvil
   * ------------------------------------------------------------------------ */

  function loadLocal() { try { return JSON.parse(localStorage.getItem(LS_KEY) || "[]"); } catch (e) { return []; } }
  function saveLocal() { try { localStorage.setItem(LS_KEY, JSON.stringify(records)); } catch (e) {} }
  function openDB() {
    return new Promise(function (res) {
      try {
        var r = indexedDB.open("fichaje-fotos", 1);
        r.onupgradeneeded = function () { r.result.createObjectStore("fotos"); };
        r.onsuccess = function () { res(r.result); };
        r.onerror = function () { res(null); };
      } catch (e) { res(null); }
    });
  }
  function putPhoto(id, blob) {
    return new Promise(function (res) {
      if (!idb) return res(false);
      var tx = idb.transaction("fotos", "readwrite");
      tx.objectStore("fotos").put(blob, id);
      tx.oncomplete = function () { res(true); };
      tx.onerror = function () { res(false); };
    });
  }
  function getPhoto(id) {
    return new Promise(function (res) {
      if (!idb) return res(null);
      var rq = idb.transaction("fotos").objectStore("fotos").get(id);
      rq.onsuccess = function () { res(rq.result || null); };
      rq.onerror = function () { res(null); };
    });
  }

  /* --------------------------------------------------------------------------
   *  Huellas SHA-256
   *  canonical(r) fija QUÉ campos entran en la huella y en qué orden. Es
   *  idéntica a la de verificar.html. No debe modificarse.
   *  Orden: id, tipo, epoch, fechaLocal, zona, lat, lon, precision, gpsEpoch,
   *         nota, dispositivo, fotoHash, prevHash
   * ------------------------------------------------------------------------ */

  function canonical(r) {
    return JSON.stringify([r.id, r.tipo, r.epoch, r.fechaLocal, r.zona, r.lat, r.lon,
      r.precision, r.gpsEpoch, r.nota, r.dispositivo, r.fotoHash || "", r.prevHash]);
  }
  function sha256(data) {
    if (!(window.crypto && crypto.subtle)) return Promise.resolve("");
    var buf = typeof data === "string" ? new TextEncoder().encode(data) : data;
    return crypto.subtle.digest("SHA-256", buf).then(function (h) {
      return Array.prototype.map.call(new Uint8Array(h), function (b) { return b.toString(16).padStart(2, "0"); }).join("");
    });
  }

  /* --------------------------------------------------------------------------
   *  GPS
   *  enableHighAccuracy: usa el GPS, no solo la red. maximumAge: 0 prohíbe
   *  reutilizar una posición antigua. «precision» = radio de error en metros
   *  que declara el propio iPhone.
   * ------------------------------------------------------------------------ */

  function getPosition() {
    return new Promise(function (res) {
      if (!("geolocation" in navigator)) return res({ error: "Este navegador no da ubicación" });
      navigator.geolocation.getCurrentPosition(
        function (p) {
          res({ lat: +p.coords.latitude.toFixed(6), lon: +p.coords.longitude.toFixed(6),
            precision: Math.round(p.coords.accuracy), gpsEpoch: p.timestamp });
        },
        function (e) {
          res({ error: e.code === 1 ? "Ubicación bloqueada: actívala en Ajustes → Privacidad y seguridad → Localización → Sitios web de Safari"
            : e.code === 3 ? "El GPS tardó demasiado" : "No se pudo obtener la ubicación" });
        },
        { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
      );
    });
  }

  /* --------------------------------------------------------------------------
   *  Horas trabajadas: cada entrada se empareja con la siguiente salida.
   * ------------------------------------------------------------------------ */

  function punches() { return records.filter(function (r) { return r.tipo === "entrada" || r.tipo === "salida"; }); }
  function lastPunch() { var p = punches(); return p[p.length - 1] || null; }
  function isIn() { var l = lastPunch(); return !!l && l.tipo === "entrada"; }
  function sessions() {
    var o = [], open = null;
    punches().forEach(function (r) {
      if (r.tipo === "entrada") open = r;
      else if (open) { o.push({ s: open.epoch, e: r.epoch }); open = null; }
    });
    if (open) o.push({ s: open.epoch, e: Date.now() }); // turno en curso
    return o;
  }
  function sumBetween(a, b) {
    var t = 0;
    sessions().forEach(function (x) { var s = Math.max(x.s, a), e = Math.min(x.e, b); if (e > s) t += e - s; });
    return t;
  }

  /* --------------------------------------------------------------------------
   *  Pantalla
   * ------------------------------------------------------------------------ */

  function renderClock() {
    var now = new Date();
    $("date").textContent = now.toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long" });
    $("time").innerHTML = pad(now.getHours()) + ":" + pad(now.getMinutes()) + "<small>" + pad(now.getSeconds()) + "</small>";
    var l = lastPunch();
    $("card").style.setProperty("--state", isIn() ? "var(--in)" : "var(--out)");
    $("status").innerHTML = isIn() ? "<b>Dentro</b> desde las " + hhmm(l.epoch) + " · " + fmtHMS(Date.now() - l.epoch)
      : l ? "<b>Fuera</b> · última salida " + new Date(l.epoch).toLocaleString("es-ES", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
      : "<b>Fuera</b>";
    var d0 = new Date(); d0.setHours(0, 0, 0, 0);
    var wk = new Date(d0); wk.setDate(wk.getDate() - ((wk.getDay() + 6) % 7)); // lunes
    var mo = new Date(d0.getFullYear(), d0.getMonth(), 1);
    $("tToday").textContent = fmtHM(sumBetween(+d0, Infinity));
    $("tWeek").textContent = fmtHM(sumBetween(+wk, Infinity));
    $("tMonth").textContent = fmtHM(sumBetween(+mo, Infinity));
  }

  function renderButton() {
    var b = $("punch");
    b.disabled = busy;
    b.textContent = busy ? "Procesando…" : isIn() ? "📷 Fichar salida" : "📷 Fichar entrada";
    b.classList.toggle("out", isIn());
  }

  function renderHistory() {
    var h = $("history");
    if (!records.length) { h.innerHTML = ""; return; }
    var groups = new Map();
    records.slice().reverse().forEach(function (r) {
      var k = dayKey(new Date(r.epoch));
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    });
    var html = "", n = 0;
    groups.forEach(function (list) {
      if (n++ >= 45) return; // últimos 45 días en pantalla; la exportación lo incluye todo
      var d = new Date(list[0].epoch), s = new Date(d); s.setHours(0, 0, 0, 0);
      var e = new Date(s); e.setDate(e.getDate() + 1);
      html += '<div class="day"><div class="dayhead"><span>' + d.toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long" }) +
        '</span><em>' + fmtHM(sumBetween(+s, +e)) + ' h</em></div>';
      list.forEach(function (r) {
        var loc = r.lat != null
          ? '<a href="https://maps.apple.com/?ll=' + r.lat + ',' + r.lon + '" target="_blank" rel="noopener">±' + r.precision + ' m · ver en mapa</a>'
          : '<span class="bad">sin ubicación</span>';
        html += '<div class="rec">' + (r.fotoId ? '<img data-foto="' + r.fotoId + '" alt="Foto, toca para guardarla">' : '') +
          '<div><span class="t">' + hhmm(r.epoch) + '</span> <span class="k ' + (r.tipo === "entrada" ? "in" : "out") + '">' + label(r.tipo) + '</span>' +
          '<div class="meta">' + loc + '</div></div></div>';
      });
      html += '</div>';
    });
    h.innerHTML = html;
    h.querySelectorAll("img[data-foto]").forEach(function (img) {
      getPhoto(img.dataset.foto).then(function (b) { if (b) img.src = URL.createObjectURL(b); });
    });
  }

  function renderAll() { renderClock(); renderButton(); renderHistory(); }

  /* --------------------------------------------------------------------------
   *  Foto: sello visible + EXIF con hora y GPS
   * ------------------------------------------------------------------------ */

  function loadImage(file) {
    return new Promise(function (res, rej) { var i = new Image(); i.onload = function () { res(i); }; i.onerror = rej; i.src = URL.createObjectURL(file); });
  }
  function dataURLtoBlob(d) {
    var bin = atob(d.split(",")[1]), a = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    return new Blob([a], { type: "image/jpeg" });
  }
  /** EXIF ImageDescription solo admite ASCII: se quitan tildes. */
  function ascii(s) { return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7E]/g, ""); }

  function stampPhoto(file, pos, when, tipo) {
    return loadImage(file).then(function (img) {
      // 1. Foto a un lienzo (máx. 2400 px de lado)
      var sc = Math.min(1, 2400 / Math.max(img.naturalWidth, img.naturalHeight));
      var w = Math.round(img.naturalWidth * sc), h = Math.round(img.naturalHeight * sc);
      var c = document.createElement("canvas"); c.width = w; c.height = h;
      var g = c.getContext("2d");
      g.drawImage(img, 0, 0, w, h);

      // 2. Franja visible con los datos
      var fs = Math.max(18, Math.round(w / 32));
      var lines = [
        label(tipo).toUpperCase() + "  " + when.toLocaleString("es-ES", { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }) + " (UTC" + off(when) + ")",
        pos.lat != null ? "GPS " + pos.lat.toFixed(6) + ", " + pos.lon.toFixed(6) + "  ±" + pos.precision + " m" : "GPS no disponible"
      ];
      var bh = Math.round(fs * 1.45 * lines.length + fs * 0.9);
      g.fillStyle = "rgba(0,0,0,.62)"; g.fillRect(0, h - bh, w, bh);
      g.fillStyle = "#fff"; g.font = "600 " + fs + "px -apple-system,system-ui,sans-serif"; g.textBaseline = "top";
      lines.forEach(function (t, i) { g.fillText(t, Math.round(fs * 0.6), h - bh + Math.round(fs * 0.45) + i * Math.round(fs * 1.45)); });

      var data = c.toDataURL("image/jpeg", 0.9);

      // 3. Metadatos EXIF
      try {
        var P = window.piexif, dt = when.getFullYear() + ":" + pad(when.getMonth() + 1) + ":" + pad(when.getDate()) + " " +
          pad(when.getHours()) + ":" + pad(when.getMinutes()) + ":" + pad(when.getSeconds());
        var zero = {}, exif = {}, gps = {};
        zero[P.ImageIFD.ImageDescription] = ascii(label(tipo) + " " + localISO(when) + (pos.lat != null ? " GPS " + pos.lat + "," + pos.lon + " +-" + pos.precision + "m" : ""));
        zero[P.ImageIFD.DateTime] = dt;
        zero[P.ImageIFD.Software] = "Mi fichaje";
        exif[P.ExifIFD.DateTimeOriginal] = dt;
        exif[P.ExifIFD.DateTimeDigitized] = dt;
        if (pos.lat != null) {
          gps[P.GPSIFD.GPSVersionID] = [2, 2, 0, 0];
          gps[P.GPSIFD.GPSLatitudeRef] = pos.lat >= 0 ? "N" : "S";
          gps[P.GPSIFD.GPSLatitude] = P.GPSHelper.degToDmsRational(Math.abs(pos.lat));
          gps[P.GPSIFD.GPSLongitudeRef] = pos.lon >= 0 ? "E" : "W";
          gps[P.GPSIFD.GPSLongitude] = P.GPSHelper.degToDmsRational(Math.abs(pos.lon));
          gps[P.GPSIFD.GPSHPositioningError] = [Math.round(pos.precision * 100), 100];
          gps[P.GPSIFD.GPSDateStamp] = when.getUTCFullYear() + ":" + pad(when.getUTCMonth() + 1) + ":" + pad(when.getUTCDate());
          gps[P.GPSIFD.GPSTimeStamp] = [[when.getUTCHours(), 1], [when.getUTCMinutes(), 1], [when.getUTCSeconds(), 1]];
        }
        data = P.insert(P.dump({ "0th": zero, "Exif": exif, "GPS": gps }), data);
      } catch (e) { console.warn("EXIF no escrito", e); }

      return dataURLtoBlob(data);
    });
  }

  /* --------------------------------------------------------------------------
   *  Fichar
   *
   *  Campos del registro: id, tipo, epoch (ms UTC del reloj del móvil),
   *  fechaLocal (ISO con desfase), zona, lat, lon, precision (m), gpsEpoch,
   *  errorGps (no entra en la huella), nota (vacía en esta versión),
   *  dispositivo (User-Agent), fotoId, fotoHash (SHA-256 del JPEG),
   *  prevHash (huella del anterior o "inicio"), hash.
   * ------------------------------------------------------------------------ */

  $("punch").onclick = function () { if (!busy) $("cam").click(); };

  $("cam").onchange = function (e) {
    var file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file || busy) return;
    var when = new Date();                       // momento de la foto
    var tipo = isIn() ? "salida" : "entrada";
    var r, blob, pos;
    busy = true; renderButton(); setMsg("Obteniendo ubicación…");

    getPosition().then(function (p) {
      pos = p;
      setMsg("Preparando la foto…");
      return stampPhoto(file, pos, when, tipo);
    }).then(function (b) {
      blob = b;
      return b.arrayBuffer().then(sha256);
    }).then(function (fotoHash) {
      var prev = records[records.length - 1];
      r = {
        id: when.getTime().toString(36) + "-" + Math.random().toString(36).slice(2, 8),
        tipo: tipo, epoch: when.getTime(), fechaLocal: localISO(when), zona: tz,
        lat: pos.lat != null ? pos.lat : null, lon: pos.lon != null ? pos.lon : null,
        precision: pos.precision != null ? pos.precision : null, gpsEpoch: pos.gpsEpoch != null ? pos.gpsEpoch : null,
        errorGps: pos.error || null, nota: "", dispositivo: navigator.userAgent.slice(0, 180),
        fotoHash: fotoHash, prevHash: prev ? (prev.hash || "") : "inicio"
      };
      r.fotoId = "foto-" + r.id;
      return putPhoto(r.fotoId, blob);
    }).then(function () {
      return sha256(canonical(r));
    }).then(function (h) {
      r.hash = h;
      records.push(r);
      saveLocal();
      busy = false; renderAll(); setMsg(pos.error || "", !!pos.error);
      openSheet(r, blob);
    }).catch(function () {
      busy = false; renderButton(); setMsg("No se pudo procesar la foto. Inténtalo otra vez.", true);
    });
  };

  /* --------------------------------------------------------------------------
   *  Guardar la foto en Fotos (hoja de compartir del iPhone)
   * ------------------------------------------------------------------------ */

  function fileName(r) { return "fichaje-" + r.tipo + "-" + r.fechaLocal.slice(0, 19).replace(/[:T]/g, "-") + ".jpg"; }

  function openSheet(r, blob) {
    lastRecord = r; lastBlob = blob;
    $("preview").src = URL.createObjectURL(blob);
    $("sheetText").innerHTML = "<b>" + label(r.tipo) + "</b> a las " + hhmm(r.epoch) +
      (r.lat != null ? " · ubicación ±" + r.precision + " m" : ' · <span class="bad">sin ubicación</span>');
    $("sheet").hidden = false;
  }
  function closeSheet() { $("sheet").hidden = true; lastBlob = null; lastRecord = null; }

  function share(blob, name) {
    var file = new File([blob], name, { type: blob.type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      return navigator.share({ files: [file] }).then(function () { return true; }, function () { return false; });
    }
    var a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    return Promise.resolve(true);
  }

  $("saveBtn").onclick = function () {
    if (!lastBlob) return;
    share(lastBlob, fileName(lastRecord)).then(function (ok) { if (ok) closeSheet(); });
  };
  $("closeBtn").onclick = closeSheet;

  // Tocar una miniatura del historial vuelve a abrir su foto para guardarla
  $("history").addEventListener("click", function (e) {
    var id = e.target.dataset && e.target.dataset.foto;
    if (!id) return;
    var r = records.find(function (x) { return x.fotoId === id; });
    getPhoto(id).then(function (b) { if (b && r) openSheet(r, b); });
  });

  /* --------------------------------------------------------------------------
   *  Exportar el registro completo (JSON) para verificar con verificar.html
   * ------------------------------------------------------------------------ */

  $("export").onclick = function (e) {
    e.preventDefault();
    if (!records.length) return setMsg("Aún no hay fichajes");
    var data = { app: "Mi fichaje", formato: 1, exportado: localISO(new Date()), zona: tz, total: records.length,
      ultimaHuella: records[records.length - 1].hash, registros: records };
    var d = new Date(), name = "fichajes-" + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + ".json";
    share(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }), name);
  };

  /* --------------------------------------------------------------------------
   *  Arranque
   * ------------------------------------------------------------------------ */

  records = loadLocal().sort(function (a, b) { return a.epoch - b.epoch; });
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});
  openDB().then(function (d) { idb = d; renderAll(); });
  renderAll();
  setInterval(renderClock, 1000);
})();
