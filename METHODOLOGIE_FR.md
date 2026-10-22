# Mi fichaje — Méthodologie (version française)

*Traduction de la documentation technique, destinée notamment aux juridictions et experts au Luxembourg. La documentation originale est en espagnol ([README.md](README.md)).*

## Objet

Application de relevé personnel du temps de travail, utilisée par le salarié lui‑même pour documenter ses heures réelles. **Chaque entrée et chaque sortie est une photo** prise à l'instant même, avec la date, l'heure et la position GPS incrustées dans l'image et inscrites dans ses métadonnées, ainsi qu'une empreinte cryptographique empêchant toute modification non détectable. La photo est ensuite enregistrée dans la photothèque du téléphone (et sa copie iCloud / Google Photos).

- Application : https://marccbalaguerr.github.io/fichaje/
- Vérification : https://marccbalaguerr.github.io/fichaje/verificar.html

## 1. Données enregistrées à chaque pointage

| Champ | Contenu | Origine |
|---|---|---|
| `id` | Identifiant unique | Généré par l'application |
| `tipo` | `entrada` (entrée), `salida` (sortie) ou `foto` (photo) | Bouton utilisé |
| `epoch` | Millisecondes depuis le 01/01/1970 UTC | Horloge système du téléphone |
| `fechaLocal` | Même heure au format ISO 8601 avec décalage horaire | Horloge système |
| `zona` | Fuseau horaire (ex. `Europe/Luxembourg`) | Système d'exploitation |
| `lat`, `lon` | Coordonnées GPS (6 décimales) | GPS du téléphone, lu à l'instant même (`maximumAge: 0`) |
| `precision` | Rayon d'incertitude en mètres | Déclaré par le système d'exploitation |
| `gpsEpoch` | Instant d'acquisition de la position | Système d'exploitation |
| `nota` | Réservé (vide dans la version actuelle) | — |
| `dispositivo` | Identification du navigateur et du système (User‑Agent) | Navigateur |
| `fotoHash` | Empreinte SHA‑256 du fichier JPEG de la photo | Calculée par l'application |
| `prevHash` | Empreinte de l'enregistrement précédent (`inicio` pour le premier) | Calculée par l'application |
| `hash` | Empreinte SHA‑256 de l'enregistrement | Calculée par l'application |

## 2. Garantie d'intégrité

**Chaîne d'empreintes.** Chaque enregistrement contient l'empreinte du précédent. L'empreinte est calculée (SHA‑256) sur la liste suivante, sérialisée en JSON, dans cet ordre exact :

```
[id, tipo, epoch, fechaLocal, zona, lat, lon, precision, gpsEpoch, nota, dispositivo, fotoHash, prevHash]
```

La modification d'un seul caractère d'un enregistrement ancien change son empreinte, qui ne correspond alors plus au `prevHash` de l'enregistrement suivant. La suppression ou la réorganisation d'un enregistrement rompt la chaîne à cet endroit.

**Ajout uniquement.** L'application ne permet ni de modifier ni de supprimer un enregistrement. Une erreur se corrige par un nouvel enregistrement accompagné d'une note.

**Photos.** Prises avec l'appareil photo au moment du pointage. L'application : (1) incruste une bande visible avec le type, la date, l'heure, le décalage horaire, les coordonnées et la précision ; (2) écrit les mêmes données dans les métadonnées EXIF standard (`DateTimeOriginal`, `GPSLatitude`, `GPSLongitude`, `GPSHPositioningError`, `GPSDateStamp`, `GPSTimeStamp` en UTC, `ImageDescription`, `Software = "Mi fichaje"`) ; (3) calcule l'empreinte SHA‑256 du fichier final et l'intègre à l'enregistrement, lui‑même chaîné. Toute retouche ultérieure est détectable.

## 3. Procédure de vérification

1. Dans l'application, « Exportar registro » (bas de l'écran) produit le fichier `fichajes-AAAAMMJJ.json`.
2. Ouvrir https://marccbalaguerr.github.io/fichaje/verificar.html dans un navigateur.
3. Sélectionner le fichier `.json` et, le cas échéant, les photos `.jpg`.
4. La page recalcule toutes les empreintes et indique, pour chaque enregistrement, son intégrité et la correspondance des photos.

Le calcul est effectué entièrement dans le navigateur du vérificateur ; aucune donnée n'est transmise. Il peut aussi être reproduit avec tout outil SHA‑256 selon la définition ci‑dessus. Les métadonnées des photos peuvent être lues avec tout lecteur EXIF (par ex. `exiftool photo.jpg`).

## 4. Limites (déclarées expressément)

- L'heure provient de l'horloge du téléphone. La chaîne prouve l'absence de modification ultérieure, mais pas à elle seule l'exactitude de l'horloge ; d'où les pratiques du point 5, qui apportent des horodatages de tiers.
- Le relevé (JSON) est conservé sur le téléphone ; s'il est effacé, les photos enregistrées dans la photothèque subsistent avec leurs données visibles et EXIF.
- La position est celle fournie par le système d'exploitation, avec la précision qu'il déclare.
- Il s'agit d'un relevé établi par le salarié lui‑même ; sa valeur repose sur sa cohérence, sa régularité et sa corroboration par d'autres éléments (témoins, messages, paiements, courriels).

## 5. Pratiques suivies pour renforcer la preuve

- Enregistrement de chaque photo dans la photothèque avec copie iCloud / Google Photos (date d'envoi enregistrée par le service, indépendante de l'utilisateur).
- Export régulier du relevé et envoi par courriel (horodatage du serveur de messagerie).
- Conservation des messages, courriels et justificatifs de paiement liés aux horaires ; identification des collègues présents.

## 6. Historique du code

L'historique Git de ce dépôt (commits horodatés par GitHub) permet d'établir quelle version du code était publiée à chaque date.
