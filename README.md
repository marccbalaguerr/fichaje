# Mi fichaje

Registro personal de jornada laboral para iPhone (y cualquier móvil), hecho por el propio trabajador para documentar sus horas reales de trabajo: entradas, salidas y fotos, cada una con hora, ubicación GPS y una huella criptográfica que impide modificar los registros sin que se note.

**App:** https://marccbalaguerr.github.io/fichaje/
**Verificación de copias:** https://marccbalaguerr.github.io/fichaje/verificar.html
**Versión en francés de la metodología:** [METHODOLOGIE_FR.md](METHODOLOGIE_FR.md)

---

## 1. Qué registra cada fichaje

| Campo | Contenido | Origen |
|---|---|---|
| `id` | Identificador único del registro | Generado por la app |
| `tipo` | `entrada`, `salida` o `foto` | Botón pulsado |
| `epoch` | Milisegundos desde 1970‑01‑01 UTC | Reloj del sistema del móvil |
| `fechaLocal` | La misma hora en ISO 8601 con desfase (p. ej. `2026-10-22T08:00:05+02:00`) | Reloj del sistema |
| `zona` | Zona horaria (p. ej. `Europe/Luxembourg`) | Sistema operativo |
| `lat`, `lon` | Coordenadas GPS con 6 decimales | GPS del móvil, leído en el momento (`maximumAge: 0`) |
| `precision` | Radio de error en metros | Declarado por el propio sistema operativo |
| `gpsEpoch` | Momento en que el sistema obtuvo la posición | Sistema operativo |
| `nota` | Texto libre (lugar, tarea, personas presentes…) | Usuario |
| `dispositivo` | Identificación del navegador y sistema (User‑Agent) | Navegador |
| `fotoHash` | SHA‑256 del archivo JPEG de la foto, si la hay | Calculado por la app |
| `prevHash` | Huella del registro anterior (`inicio` en el primero) | Calculado por la app |
| `hash` | SHA‑256 del registro completo | Calculado por la app |

## 2. Cómo se garantiza la integridad

**Cadena de huellas.** Cada registro contiene la huella del anterior. La huella de un registro se calcula con SHA‑256 sobre esta lista exacta de campos, serializada en JSON y en este orden:

```
[id, tipo, epoch, fechaLocal, zona, lat, lon, precision, gpsEpoch, nota, dispositivo, fotoHash, prevHash]
```

Si alguien cambia un solo carácter de un registro antiguo, su huella cambia y deja de coincidir con el `prevHash` del siguiente. Si se borra o se reordena un registro, la cadena se rompe en ese punto. Es el mismo principio que usan los sistemas de registro de auditoría.

**Solo añadir.** La app no tiene ninguna función para editar ni borrar registros. Los errores se corrigen con un registro nuevo y una nota explicativa.

**Fotos.** Las fotos se hacen con la cámara en el momento del fichaje. La app:
1. graba en la propia imagen una franja visible con tipo de registro, fecha, hora, desfase horario, coordenadas y precisión;
2. escribe los mismos datos en los metadatos EXIF estándar (`DateTimeOriginal`, `GPSLatitude`, `GPSLongitude`, `GPSHPositioningError`, `GPSDateStamp`, `GPSTimeStamp` en UTC, `ImageDescription`, `Software = "Mi fichaje"`);
3. calcula la SHA‑256 del archivo final y la incluye en el registro (`fotoHash`), que a su vez entra en la cadena.

Cualquier retoque de la foto después de hacerla cambia su huella y es detectable.

## 3. Cómo verificar una copia (para peritos y juzgados)

1. En la app, pulsar **Descargar copia** para obtener el archivo `fichajes-copia-AAAAMMDD-HHMM.json`.
2. Abrir **https://marccbalaguerr.github.io/fichaje/verificar.html** en cualquier navegador.
3. Seleccionar el archivo `.json` y, opcionalmente, las fotos `.jpg`.
4. La página recalcula todas las huellas y muestra, registro por registro, si son íntegros y si cada foto coincide con la registrada.

La verificación se hace por completo en el navegador de quien verifica; no se envía ningún dato a internet. También puede reproducirse con cualquier herramienta SHA‑256 siguiendo la definición del apartado 2. El código de la verificación está en `verificar.html` y es idéntico al de `app.js` (función `canonical`).

Para comprobar los metadatos de una foto puede usarse cualquier lector EXIF (por ejemplo `exiftool foto.jpg`).

## 4. Limitaciones (declaradas expresamente)

- **La hora procede del reloj del móvil.** La cadena demuestra que los registros no se han alterado después, pero no prueba por sí sola que el reloj fuera correcto. Por eso se siguen las prácticas del apartado 5, que aportan sellos de tiempo de terceros.
- **Los datos se guardan solo en el móvil** (almacenamiento local del navegador). Si se borran los datos del navegador o se pierde el móvil, solo quedan las copias exportadas o enviadas.
- **La ubicación es la que da el sistema operativo**, con la precisión que él mismo declara en metros.
- **Es un registro de parte.** Lo elabora el propio trabajador; su valor está en la coherencia, la regularidad y su corroboración con otras pruebas (testigos, mensajes, pagos, correos).

## 5. Prácticas recomendadas para reforzar la prueba

- **Enviarse los registros por correo cada día** con el botón «Enviarme por correo». El servidor de correo añade su propia fecha, independiente del usuario.
- **Exportar la copia completa (.json) cada semana** y guardarla fuera del móvil (correo, nube).
- **Guardar las fotos en el carrete** con «Guardar / enviar foto».
- **Anotar en la nota** el lugar, la tarea y las personas presentes, que pueden declarar como testigos.
- **Conservar mensajes, correos y justificantes de pago** relacionados con los horarios.

## 6. Historial del código

El historial de cambios de este repositorio (commits de Git, con fecha registrada por GitHub) permite comprobar qué versión del código estaba publicada en cada momento.

## 7. Archivos

| Archivo | Función |
|---|---|
| `index.html` | Pantalla de la app |
| `app.js` | Toda la lógica, comentada |
| `styles.css` | Aspecto visual (no afecta a los datos) |
| `verificar.html` | Verificación independiente de copias y fotos |
| `lib/piexif.js` | Librería de terceros (licencia MIT) para escribir EXIF |
| `METHODOLOGIE_FR.md` | Metodología en francés |

## 8. Privacidad

El código es público; los datos no. Los fichajes y fotos se guardan únicamente en el móvil del usuario y solo salen de él cuando el propio usuario los exporta o se los envía.
