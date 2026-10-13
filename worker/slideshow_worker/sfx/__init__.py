"""Sound-effect sourcing. Only licences safe for a monetised channel are accepted.

Allowed: CC0, Public Domain Mark, CC BY (credited in the description), the operator's own
licensed local library, and (optionally) ElevenLabs-generated clips on a paid plan.

Rejected: NC (non-commercial), Sampling+, BY-SA (syncing to video is an adaptation, which would
force the whole video under BY-SA) and BY-ND (no adaptations allowed). BBC RemArc is never used.
"""

ALLOWED_CC = {"cc0", "pdm", "by"}
ATTRIBUTION_REQUIRED = {"by"}
LICENSE_URLS = {
    "cc0": "https://creativecommons.org/publicdomain/zero/1.0/",
    "pdm": "https://creativecommons.org/publicdomain/mark/1.0/",
}
