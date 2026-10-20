---
description: "ompkit-gm0v: fleet-owned engineering (binding, custody, routes, render integration) is decided from metadata and source, never delegated upward as owner homework"
condition:
  # Fire: an ownership destination for engineering-decidable work.
  # - ownership-deferred replies (money-quiet: a $ amount within 80 chars behind vetoes; spending authority is genuinely the human's).
  # - decidable object (binding/custody/auth/route/render/integration/mount/decision/approval/engineering)
  #   sent upward within one line.
  # - destination plus a decision verb (routine status reporting with no decision verb stays quiet).
  # - approval sentences naming an engineering object with at most 4 small words between (money objects like
  #   "budget increase" are not in the object list, so the planted "$2k ad budget" quiet row never matches
  #   at any streamed prefix).
  - '\bowner''s call\b(?<![^\n]{0,80}\$[0-9][^\n]{0,80})'
  - '(?:binding|custody|auth(?:entication|ories)?|routes?|renders?|integrations?|mounts?|decisions?|approv(?:ed|al)|engineering).{0,60}?(?:to Josh|to the owner)\b'
  - '\bto Josh to (?:decide|approve|engineer|figure out|own)\b'
  - '\bJosh (?:must|has to|needs to) approve (?:the |this )?(?:[A-Za-z-]+ ){0,4}?(?:binding|custody|auth(?:entication|ories)?|routes?|renders?|integrations?|mounts?)\b'
scope: text
interruptMode: never
---
Fleet-owned engineering is decided from authoritative metadata, repo source and the infisical-secrets skill — opportunity binding, mount-source custody, the private-auth route, mounted render integration. Assigning one upward as owner homework instead of deciding it is an omp-kit failure. Genuine authority gaps (spending approval with amounts, director rulings with tried options on record) stay quiet: they name the decision AND what was tried, not just the destination.
