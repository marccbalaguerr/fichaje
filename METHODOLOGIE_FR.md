# Mi fichaje — Méthodologie (version française)

*Traduction de la documentation technique, destinée notamment aux juridictions et experts au Luxembourg. La documentation originale est en espagnol ([README.md](README.md)).*

## Objet

Application de relevé personnel du temps de travail, utilisée par le salarié lui‑même pour documenter ses heures réelles : entrées, sorties et photos, chacune avec l'heure, la position GPS et une empreinte cryptographique empêchant toute modification non détectable.

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
| `nota` | Note libre (lieu, tâche, personnes présentes…) | Utilisateur |
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

## 3. Copie automatique sur GitHub et horodatage par un tiers

Lorsqu'elle est activée, chaque enregistrement et chaque photo sont envoyés automatiquement vers un **dépôt privé** de l'utilisateur, chacun dans un **commit distinct** (`registros/AAAA/MM/…json`, `fotos/AAAA/MM/…jpg`).

- L'application **n'indique aucune date de commit** : GitHub attribue la date de son serveur au moment de la réception. Cette date est **indépendante de l'horloge du téléphone** et conservée par un tiers (GitHub, Inc.).
- La comparaison entre l'heure de l'enregistrement (`fechaLocal`) et celle du commit permet de vérifier que l'enregistrement a été créé à ce moment et non a posteriori. Sans réseau, l'envoi a lieu au retour de la connexion ; l'écart reste visible.
- Les fichiers **ne sont jamais écrasés** : un envoi vers un fichier existant est refusé.
- La clé d'accès utilisée est de type *fine‑grained*, limitée à ce dépôt et à la permission « Contents ».

## 4. Procédure de vérification

1. Dans l'application, « Descargar copia » produit le fichier `fichajes-copia-AAAAMMJJ-HHMM.json`.
2. Ouvrir https://marccbalaguerr.github.io/fichaje/verificar.html dans un navigateur.
3. Sélectionner le fichier `.json` et, le cas échéant, les photos `.jpg`.
4. La page recalcule toutes les empreintes et indique, pour chaque enregistrement, son intégrité et la correspondance des photos.

Le calcul est effectué entièrement dans le navigateur du vérificateur ; aucune donnée n'est transmise. Il peut aussi être reproduit avec tout outil SHA‑256 selon la définition ci‑dessus. Les métadonnées des photos peuvent être lues avec tout lecteur EXIF (par ex. `exiftool photo.jpg`).

## 5. Limites (déclarées expressément)

- L'heure provient de l'horloge du téléphone. La chaîne prouve l'absence de modification ultérieure, mais pas à elle seule l'exactitude de l'horloge ; d'où la copie sur GitHub (point 3) et les pratiques du point 6, qui apportent des horodatages de tiers.
- Les données sont conservées uniquement sur le téléphone ; en cas de perte, seules subsistent les copies exportées ou envoyées.
- La position est celle fournie par le système d'exploitation, avec la précision qu'il déclare.
- Il s'agit d'un relevé établi par le salarié lui‑même ; sa valeur repose sur sa cohérence, sa régularité et sa corroboration par d'autres éléments (témoins, messages, paiements, courriels).

## 6. Pratiques suivies pour renforcer la preuve

- Copie automatique sur GitHub activée.
- Envoi régulier des relevés par courriel (horodatage indépendant du serveur de messagerie).
- Export hebdomadaire de la copie complète, conservée hors du téléphone.
- Conservation des photos dans la photothèque.
- Indication dans les notes du lieu, de la tâche et des personnes présentes.
- Conservation des messages, courriels et justificatifs de paiement liés aux horaires.

## 7. Historique du code

L'historique Git de ce dépôt (commits horodatés par GitHub) permet d'établir quelle version du code était publiée à chaque date.
