/*
 * ============================================================================
 *  app.js — Lógica de la aplicación «Mi fichaje»
 * ============================================================================
 *
 *  FINALIDAD
 *  Registro personal de horas de trabajo (entradas, salidas y fotos) hecho por
 *  el propio trabajador, para poder acreditar las horas realmente trabajadas.
 *
 *  PRINCIPIOS DE DISEÑO (relevantes como prueba)
 *  1. Solo añadir: la app no tiene ninguna función para editar ni borrar un
 *     registro. Un error se corrige con un registro nuevo y una nota.
 *  2. Cadena de huellas: cada registro incluye la huella SHA-256 del registro
 *     anterior («prevHash») y su propia huella («hash»). Si se cambia, borra o
 *     reordena cualquier registro antiguo, la cadena deja de cuadrar y se
 *     detecta (función verify() y página verificar.html).
 *  3. Ubicación real: las coordenadas se piden en el momento al GPS del móvil
 *     mediante la API estándar del navegador (navigator.geolocation), con la
 *     precisión que el propio sistema operativo declara, en metros.
 *  4. Fotos: se hacen con la cámara en el momento. Se les graba un sello
 *     visible (fecha, hora, coordenadas) y los mismos datos en los metadatos
 *     EXIF. La huella SHA-256 del archivo de la foto entra en la cadena, por lo
 *     que cualquier retoque posterior de la foto es detectable.
 *  5. Sin servidores: todo se procesa y guarda en el propio móvil. No se envía
 *     nada a terceros salvo cuando el usuario lo exporta o se lo envía por correo.
 *
 *  LIMITACIONES CONOCIDAS (declaradas expresamente)
 *  - La hora procede del reloj del móvil. Por eso se recomienda enviarse por
 *    correo los registros a diario: el servidor de correo añade su propia
 *    fecha, independiente del usuario.
 *  - La huella demuestra integridad (que nada se ha cambiado después), no
 *    autoría por un tercero independiente.
 *
 *  Este archivo no usa librerías externas salvo lib/piexif.js (licencia MIT),
 *  que solo sirve para escribir los metadatos EXIF de las fotos.
 * ============================================================================
 */
(function () {
  "use strict";

  /* --------------------------------------------------------------------------
   *  Constantes y utilidades
   * ------------------------------------------------------------------------ */

  /** Clave bajo la que se guardan los registros en el almacenamiento del móvil. */
  var LS_KEY = "fichaje.registros.v1";

  /** Atajo para obtener un elemento de la página por su id. */
  var $ = function (id) { return document.getElementById(id); };

  /** Lista de registros, siempre ordenada por momento (epoch) ascendente. */
  var records = [];
  /** Evita dobles pulsaciones mientras se está creando un registro. */
  var busy = false;
  /** Tipo de registro pendiente cuando se abre la cámara. */
  var photoMode = null;
  /** Base de datos local (IndexedDB) donde se guardan las fotos. */
  var idb = null;

  /** Rellena con cero a la izquierda (7 -> "07"). */
  function pad(n) { return String(n).padStart(2, "0"); }
  /** Milisegundos -> "h:mm". */
  function fmtHM(ms) { var m = Math.round(ms / 60000); return Math.floor(m / 60) + ":" + pad(m % 60); }
  /** Milisegundos -> "h:mm:ss". */
  function fmtHMS(ms) { var s = Math.floor(ms / 1000); return Math.floor(s / 3600) + ":" + pad(Math.floor(s / 60) % 60) + ":" + pad(s % 60); }
  /** Fecha -> "AAAA-MM-DD" (día local), para agrupar el historial. */
  function dayKey(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  /** Zona horaria del móvil según el sistema (p. ej. "Europe/Luxembourg"). */
  var tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  /** Desfase respecto a UTC de una fecha concreta, p. ej. "+02:00". */
  function off(d) { var o = -d.getTimezoneOffset(), a = Math.abs(o); return (o >= 0 ? "+" : "-") + pad(Math.floor(a / 60)) + ":" + pad(a % 60); }
  /** Fecha -> ISO 8601 en hora local con su desfase, p. ej. "2026-10-22T08:00:05+02:00". */
  function localISO(d) {
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" +
      pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds()) + off(d);
  }
  /** Escapa texto para mostrarlo en la página sin interpretarlo como HTML. */
  function esc(s) { var d = document.createElement("div"); d.textContent = s; return d.innerHTML; }
  /** Muestra un mensaje de estado bajo los botones. */
  function setMsg(t, c) { var m = $("msg"); m.textContent = t; m.className = "msg" + (c ? " " + c : ""); }

  /* --------------------------------------------------------------------------
   *  Almacenamiento local
   *  - Registros: localStorage (texto JSON).
   *  - Fotos: IndexedDB (archivos binarios), por su tamaño.
   * ------------------------------------------------------------------------ */

  function loadLocal() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || "[]"); } catch (e) { return []; }
  }
  function saveLocal() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(records)); }
    catch (e) { setMsg("No se pudo guardar en el móvil: ¿modo privado?", "err"); }
  }
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
   *
   *  canonical(r) define EXACTAMENTE qué campos de un registro entran en su
   *  huella y en qué orden. Es la misma función que usa verificar.html para
   *  comprobar los registros de forma independiente. No debe modificarse:
   *  cambiarla invalidaría la verificación de los registros ya hechos.
   *
   *  Campos (en este orden):
   *    id, tipo, epoch, fechaLocal, zona, lat, lon, precision, gpsEpoch,
   *    nota, dispositivo, fotoHash, prevHash
   * ------------------------------------------------------------------------ */

  function canonical(r) {
    return JSON.stringify([r.id, r.tipo, r.epoch, r.fechaLocal, r.zona, r.lat, r.lon,
      r.precision, r.gpsEpoch, r.nota, r.dispositivo, r.fotoHash || "", r.prevHash]);
  }
  /** SHA-256 en hexadecimal de un texto o de un ArrayBuffer (API Web Crypto estándar). */
  function sha256(data) {
    if (!(window.crypto && crypto.subtle)) return Promise.resolve("");
    var buf = typeof data === "string" ? new TextEncoder().encode(data) : data;
    return crypto.subtle.digest("SHA-256", buf).then(function (h) {
      return Array.prototype.map.call(new Uint8Array(h), function (b) { return b.toString(16).padStart(2, "0"); }).join("");
    });
  }

  /* --------------------------------------------------------------------------
   *  Ubicación GPS
   *  enableHighAccuracy: pide el GPS, no solo la red.
   *  maximumAge: 0       : prohíbe usar una ubicación antigua guardada.
   *  «precision» es el radio de error en metros que declara el propio iPhone.
   * ------------------------------------------------------------------------ */

  function getPosition() {
    return new Promise(function (res) {
      if (!("geolocation" in navigator)) return res({ error: "Este navegador no da ubicación" });
      navigator.geolocation.getCurrentPosition(
        function (p) {
          res({
            lat: +p.coords.latitude.toFixed(6),
            lon: +p.coords.longitude.toFixed(6),
            precision: Math.round(p.coords.accuracy),
            gpsEpoch: p.timestamp // momento en que el sistema obtuvo la posición
          });
        },
        function (e) {
          res({ error: e.code === 1 ? "Permiso de ubicación denegado" : e.code === 3 ? "El GPS tardó demasiado" : "No se pudo obtener la ubicación" });
        },
        { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
      );
    });
  }
  /** Muestra si la ubicación está permitida, bloqueada o pendiente de pedir. */
  function checkPerm() {
    if (!navigator.permissions || !navigator.permissions.query) return;
    navigator.permissions.query({ name: "geolocation" }).then(function (s) {
      function show() {
        $("gpsState").textContent = s.state === "granted" ? "📍 Ubicación activada"
          : s.state === "denied" ? "📍 Ubicación bloqueada: actívala en Ajustes → Privacidad y seguridad → Localización → Sitios web de Safari"
          : "📍 Te pedirá la ubicación al fichar";
      }
      show(); s.onchange = show;
    }).catch(function () {});
  }

  /* --------------------------------------------------------------------------
   *  Cálculo de horas
   *  Solo cuentan los registros «entrada» y «salida». Las «fotos de prueba»
   *  no alteran el cómputo. Cada entrada se empareja con la siguiente salida.
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
  /** Milisegundos trabajados dentro del intervalo [a, b). */
  function sumBetween(a, b) {
    var t = 0;
    sessions().forEach(function (x) { var s = Math.max(x.s, a), e = Math.min(x.e, b); if (e > s) t += e - s; });
    return t;
  }

  /* --------------------------------------------------------------------------
   *  Pantalla
   * ------------------------------------------------------------------------ */

  function label(t) { return t === "entrada" ? "Entrada" : t === "salida" ? "Salida" : "Foto"; }
  function cls(t) { return t === "entrada" ? "in" : t === "salida" ? "out" : "foto"; }

  function renderClock() {
    var now = new Date();
    $("date").textContent = now.toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long" });
    $("time").innerHTML = pad(now.getHours()) + ":" + pad(now.getMinutes()) + "<small>" + pad(now.getSeconds()) + "</small>";
    var l = lastPunch();
    if (isIn()) {
      $("card").style.setProperty("--state", "var(--in)");
      $("status").innerHTML = "<b>Dentro</b> desde las " + new Date(l.epoch).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" }) + " · " + fmtHMS(Date.now() - l.epoch);
    } else {
      $("card").style.setProperty("--state", "var(--out)");
      $("status").innerHTML = l ? "<b>Fuera</b> · última salida " + new Date(l.epoch).toLocaleString("es-ES", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
        : "<b>Fuera</b> · aún no hay fichajes";
    }
    var d0 = new Date(); d0.setHours(0, 0, 0, 0);
    var wk = new Date(d0); wk.setDate(wk.getDate() - ((wk.getDay() + 6) % 7)); // lunes de esta semana
    var mo = new Date(d0.getFullYear(), d0.getMonth(), 1);
    $("tToday").textContent = fmtHM(sumBetween(+d0, Infinity));
    $("tWeek").textContent = fmtHM(sumBetween(+wk, Infinity));
    $("tMonth").textContent = fmtHM(sumBetween(+mo, Infinity));
  }

  function renderButtons() {
    var p = $("punch");
    p.disabled = busy; $("punchPhoto").disabled = busy; $("onlyPhoto").disabled = busy;
    p.textContent = busy ? "Fichando…" : isIn() ? "Fichar salida" : "Fichar entrada";
    p.classList.toggle("out", isIn());
    $("punchPhoto").textContent = isIn() ? "📷 Salida con foto" : "📷 Entrada con foto";
  }

  function renderHistory() {
    var h = $("history");
    if (!records.length) { h.innerHTML = '<div class="empty">Tu primer fichaje aparecerá aquí con su hora y ubicación.</div>'; return; }
    var groups = new Map();
    records.slice().reverse().forEach(function (r) {
      var k = dayKey(new Date(r.epoch));
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    });
    var html = "", n = 0;
    groups.forEach(function (list) {
      if (n++ >= 45) return; // se muestran los últimos 45 días; la exportación incluye todo
      var d = new Date(list[0].epoch), s = new Date(d); s.setHours(0, 0, 0, 0);
      var e = new Date(s); e.setDate(e.getDate() + 1);
      html += '<div class="day"><div class="dayhead"><span>' + d.toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long" }) +
        '</span><em>' + fmtHM(sumBetween(+s, +e)) + ' h</em></div>';
      list.forEach(function (r) {
        var t = new Date(r.epoch).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
        var loc = r.lat != null
          ? '<a href="https://maps.apple.com/?ll=' + r.lat + ',' + r.lon + '&q=' + encodeURIComponent(label(r.tipo)) + '" target="_blank" rel="noopener">' +
            r.lat.toFixed(5) + ', ' + r.lon.toFixed(5) + '</a> (±' + r.precision + ' m)'
          : '<span class="bad">Sin ubicación: ' + esc(r.errorGps || "no disponible") + '</span>';
        html += '<div class="rec"><span class="t">' + t + '</span><span class="k ' + cls(r.tipo) + '">' + label(r.tipo) + '</span>' +
          '<span class="meta">' + loc + (r.nota ? '<br>' + esc(r.nota) : '') + '<br>Huella ' + (r.hash || '').slice(0, 12) + '…</span>' +
          (r.fotoId ? '<div class="thumb" data-foto="' + r.fotoId + '"><img alt="Foto del fichaje"><button data-share="' + r.fotoId + '">Guardar / enviar foto</button></div>' : '') +
          '</div>';
      });
      html += '</div>';
    });
    h.innerHTML = html;
    // Miniaturas de las fotos (se leen de IndexedDB)
    h.querySelectorAll("[data-foto]").forEach(function (el) {
      getPhoto(el.dataset.foto).then(function (b) {
        if (b) el.querySelector("img").src = URL.createObjectURL(b);
        else el.querySelector("button").textContent = "Foto no disponible";
      });
    });
  }

  function renderAll() { renderClock(); renderButtons(); renderHistory(); }

  /* --------------------------------------------------------------------------
   *  Fotos: sello visible + metadatos EXIF con GPS y hora
   *
   *  1. Se dibuja la foto en un lienzo (máx. 2400 px de lado).
   *  2. Se añade una franja inferior con tipo, fecha, hora, desfase horario,
   *     coordenadas, precisión y nota.
   *  3. Se codifica en JPEG y se le insertan metadatos EXIF:
   *       - DateTime / DateTimeOriginal / DateTimeDigitized (hora local)
   *       - GPSLatitude / GPSLongitude (+ referencias N/S, E/W)
   *       - GPSHPositioningError (precisión en metros)
   *       - GPSDateStamp / GPSTimeStamp (hora UTC)
   *       - ImageDescription (resumen legible) y Software = "Mi fichaje"
   *  4. Se calcula la SHA-256 del JPEG final; esa huella entra en el registro.
   * ------------------------------------------------------------------------ */

  function loadImage(file) {
    return new Promise(function (res, rej) {
      var i = new Image();
      i.onload = function () { res(i); };
      i.onerror = rej;
      i.src = URL.createObjectURL(file);
    });
  }
  function dataURLtoBlob(d) {
    var b = d.split(",")[1], bin = atob(b), a = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    return new Blob([a], { type: "image/jpeg" });
  }
  /** El estándar EXIF solo admite ASCII en ImageDescription: se quitan tildes. */
  function ascii(s) { return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7E]/g, ""); }

  function stampPhoto(file, pos, when, tipo, nota) {
    return loadImage(file).then(function (img) {
      var max = 2400, sc = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      var w = Math.round(img.naturalWidth * sc), h = Math.round(img.naturalHeight * sc);
      var c = document.createElement("canvas"); c.width = w; c.height = h;
      var g = c.getContext("2d");
      g.drawImage(img, 0, 0, w, h);

      // Sello visible
      var fs = Math.max(18, Math.round(w / 34));
      var lines = [
        label(tipo).toUpperCase() + "  " + when.toLocaleString("es-ES", { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }) + " (" + off(when) + ")",
        pos.lat != null ? ("GPS " + pos.lat.toFixed(6) + ", " + pos.lon.toFixed(6) + "  ±" + pos.precision + " m") : "GPS no disponible"
      ];
      if (nota) lines.push(nota.slice(0, 80));
      var bh = Math.round(fs * 1.45 * lines.length + fs * 0.9);
      g.fillStyle = "rgba(0,0,0,.62)"; g.fillRect(0, h - bh, w, bh);
      g.fillStyle = "#fff"; g.font = "600 " + fs + "px -apple-system,system-ui,sans-serif"; g.textBaseline = "top";
      lines.forEach(function (t, i) { g.fillText(t, Math.round(fs * 0.6), h - bh + Math.round(fs * 0.45) + i * Math.round(fs * 1.45)); });

      var data = c.toDataURL("image/jpeg", 0.9);

      // Metadatos EXIF
      try {
        var P = window.piexif, u = new Date(when.getTime());
        var dt = when.getFullYear() + ":" + pad(when.getMonth() + 1) + ":" + pad(when.getDate()) + " " + pad(when.getHours()) + ":" + pad(when.getMinutes()) + ":" + pad(when.getSeconds());
        var zero = {}, exif = {}, gps = {};
        zero[P.ImageIFD.ImageDescription] = ascii(label(tipo) + " " + localISO(when) + (pos.lat != null ? " GPS " + pos.lat + "," + pos.lon + " +-" + pos.precision + "m" : "") + (nota ? " | " + nota : ""));
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
          gps[P.GPSIFD.GPSDateStamp] = u.getUTCFullYear() + ":" + pad(u.getUTCMonth() + 1) + ":" + pad(u.getUTCDate());
          gps[P.GPSIFD.GPSTimeStamp] = [[u.getUTCHours(), 1], [u.getUTCMinutes(), 1], [u.getUTCSeconds(), 1]];
        }
        data = P.insert(P.dump({ "0th": zero, "Exif": exif, "GPS": gps }), data);
      } catch (e) { console.warn("No se pudieron escribir los EXIF", e); }

      return dataURLtoBlob(data);
    });
  }

  /* --------------------------------------------------------------------------
   *  Crear un registro (entrada, salida o foto)
   *
   *  Estructura de cada registro:
   *    id          identificador único (momento en base 36 + aleatorio)
   *    tipo        "entrada" | "salida" | "foto"
   *    epoch       milisegundos desde 1970-01-01 UTC (reloj del móvil)
   *    fechaLocal  misma hora en ISO 8601 local con desfase
   *    zona        zona horaria del sistema
   *    lat, lon    coordenadas GPS (6 decimales ≈ 0,1 m) o null
   *    precision   radio de error en metros declarado por el sistema, o null
   *    gpsEpoch    momento de la lectura GPS según el sistema, o null
   *    errorGps    motivo si no hubo ubicación, o null (no entra en la huella)
   *    nota        texto libre opcional del usuario
   *    dispositivo identificación del navegador y sistema (User-Agent)
   *    fotoId      referencia a la foto guardada (solo si hay foto)
   *    fotoHash    SHA-256 del archivo JPEG de la foto (solo si hay foto)
   *    prevHash    huella del registro anterior ("inicio" en el primero)
   *    hash        SHA-256 de canonical(registro)
   * ------------------------------------------------------------------------ */

  function addRecord(tipo, file) {
    if (busy) return;
    busy = true; renderButtons(); setMsg("Obteniendo ubicación GPS…");
    var now, nota, r, blob = null, pos;

    getPosition().then(function (p) {
      pos = p;
      now = new Date();
      nota = $("note").value.trim();
      var prev = records[records.length - 1];
      r = {
        id: now.getTime().toString(36) + "-" + Math.random().toString(36).slice(2, 8),
        tipo: tipo,
        epoch: now.getTime(),
        fechaLocal: localISO(now),
        zona: tz,
        lat: pos.lat != null ? pos.lat : null,
        lon: pos.lon != null ? pos.lon : null,
        precision: pos.precision != null ? pos.precision : null,
        gpsEpoch: pos.gpsEpoch != null ? pos.gpsEpoch : null,
        errorGps: pos.error || null,
        nota: nota,
        dispositivo: navigator.userAgent.slice(0, 180),
        prevHash: prev ? (prev.hash || "") : "inicio"
      };
      if (!file) return null;
      setMsg("Preparando la foto…");
      return stampPhoto(file, pos, now, tipo, nota).then(function (b) {
        blob = b;
        return b.arrayBuffer();
      }).then(function (buf) {
        return sha256(buf);
      }).then(function (fh) {
        r.fotoHash = fh;
        r.fotoId = "foto-" + r.id;
        return putPhoto(r.fotoId, blob);
      }).then(function (ok) {
        if (!ok) setMsg("No se pudo guardar la foto en el móvil", "err");
      }).catch(function () { setMsg("No se pudo procesar la foto", "err"); });
    }).then(function () {
      return sha256(canonical(r));
    }).then(function (h) {
      r.hash = h;
      records.push(r);
      saveLocal();
      $("note").value = "";
      busy = false;
      renderAll();
      var hora = now.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
      setMsg(label(tipo) + " a las " + hora + (pos.error ? " · " + pos.error : " con ubicación (±" + r.precision + " m)") +
        (blob ? " · foto guardada. Pulsa «Guardar / enviar foto» para pasarla al carrete." : ""), pos.error ? "err" : "ok");
    });
  }

  $("punch").onclick = function () { addRecord(isIn() ? "salida" : "entrada"); };
  $("punchPhoto").onclick = function () { photoMode = isIn() ? "salida" : "entrada"; $("cam").click(); };
  $("onlyPhoto").onclick = function () { photoMode = "foto"; $("cam").click(); };
  $("cam").onchange = function (e) {
    var f = e.target.files && e.target.files[0];
    e.target.value = "";
    if (f && photoMode) addRecord(photoMode, f);
    photoMode = null;
  };

  /* --------------------------------------------------------------------------
   *  Exportar y compartir
   *  Se usa la hoja de compartir del iPhone (Guardar imagen, Mail, WhatsApp…)
   *  y, si no está disponible, una descarga normal.
   * ------------------------------------------------------------------------ */

  function shareOrDownload(blob, name, text) {
    var file = new File([blob], name, { type: blob.type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      return navigator.share({ files: [file], text: text }).catch(function (e) {
        if (e.name !== "AbortError") download(blob, name);
      });
    }
    download(blob, name);
  }
  function download(blob, name) {
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
  }
  function stamp() { var d = new Date(); return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + "-" + pad(d.getHours()) + pad(d.getMinutes()); }

  $("history").addEventListener("click", function (e) {
    var id = e.target.dataset && e.target.dataset.share;
    if (!id) return;
    getPhoto(id).then(function (b) {
      if (!b) return setMsg("Esta foto ya no está en el móvil", "err");
      var r = records.find(function (x) { return x.fotoId === id; });
      shareOrDownload(b, "fichaje-" + (r ? r.fechaLocal.slice(0, 19).replace(/[:T]/g, "-") : id) + ".jpg", r ? label(r.tipo) + " " + r.fechaLocal : "");
    });
  });

  /** CSV legible en Excel (con BOM UTF-8 para las tildes). */
  function csv() {
    var head = ["tipo", "fecha_hora_local", "zona", "latitud", "longitud", "precision_m", "nota", "huella_foto", "huella", "huella_anterior", "id"];
    function q(v) { var s = v == null ? "" : String(v); return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
    return "\uFEFF" + [head.join(",")].concat(records.map(function (r) {
      return [r.tipo, r.fechaLocal, r.zona, r.lat, r.lon, r.precision, r.nota, r.fotoHash, r.hash, r.prevHash, r.id].map(q).join(",");
    })).join("\n");
  }
  $("csv").onclick = function () {
    if (!records.length) return setMsg("Aún no hay fichajes");
    shareOrDownload(new Blob([csv()], { type: "text/csv" }), "fichajes-" + stamp() + ".csv", "");
  };
  /** Copia completa en JSON: es el archivo que se verifica con verificar.html. */
  $("json").onclick = function () {
    if (!records.length) return setMsg("Aún no hay fichajes");
    var data = { app: "Mi fichaje", formato: 1, exportado: localISO(new Date()), zona: tz, total: records.length,
      ultimaHuella: records[records.length - 1].hash, registros: records };
    shareOrDownload(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }), "fichajes-copia-" + stamp() + ".json", "");
  };
  /** Abre Mail con el resumen de los últimos 14 días, para tener sello de fecha de terceros. */
  $("mail").onclick = function () {
    if (!records.length) return setMsg("Aún no hay fichajes");
    var since = Date.now() - 14 * 864e5;
    var lines = records.filter(function (r) { return r.epoch >= since; }).map(function (r) {
      return label(r.tipo).toUpperCase() + " " + r.fechaLocal + " | " + (r.lat != null ? r.lat + "," + r.lon + " (±" + r.precision + "m)" : "sin GPS") +
        (r.nota ? " | " + r.nota : "") + (r.fotoHash ? " | foto " + r.fotoHash.slice(0, 16) : "") + " | #" + r.hash.slice(0, 16);
    });
    var body = "Registro de fichajes (últimos 14 días)\nEnviado: " + localISO(new Date()) + "\n\n" + lines.join("\n") +
      "\n\nÚltima huella: " + records[records.length - 1].hash;
    location.href = "mailto:?subject=" + encodeURIComponent("Fichajes " + new Date().toLocaleDateString("es-ES")) + "&body=" + encodeURIComponent(body);
  };

  /* --------------------------------------------------------------------------
   *  Comprobación de integridad (misma lógica que verificar.html)
   * ------------------------------------------------------------------------ */

  $("verify").onclick = function () {
    var el = $("chain");
    if (!records.length) { el.className = "chain"; el.textContent = "Aún no hay fichajes."; return; }
    var prev = "inicio", bad = 0, badFoto = 0;
    var p = Promise.resolve();
    records.forEach(function (r) {
      p = p.then(function () { return sha256(canonical(r)); }).then(function (h) {
        if (h !== r.hash || r.prevHash !== prev) bad++;
        prev = r.hash;
        if (!r.fotoId) return;
        return getPhoto(r.fotoId).then(function (b) {
          if (!b) return;
          return b.arrayBuffer().then(sha256).then(function (fh) { if (fh !== r.fotoHash) badFoto++; });
        });
      });
    });
    p.then(function () {
      if (!bad && !badFoto) { el.className = "chain ok"; el.textContent = "Los " + records.length + " registros y sus fotos están intactos y en orden."; }
      else { el.className = "chain bad"; el.textContent = (bad ? bad + " registro(s) no cuadran con la cadena. " : "") + (badFoto ? badFoto + " foto(s) han sido modificadas." : ""); }
    });
  };

  /* --------------------------------------------------------------------------
   *  Arranque
   * ------------------------------------------------------------------------ */

  records = loadLocal().sort(function (a, b) { return a.epoch - b.epoch; });
  // Pide al sistema que no borre los datos de esta web por falta de espacio.
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});
  openDB().then(function (d) { idb = d; renderAll(); });
  renderAll();
  checkPerm();
  setInterval(renderClock, 1000);
})();
