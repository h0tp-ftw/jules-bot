#!/bin/bash
LAST_TAG=$(gh api repos/h0tp-ftw/ankimon/releases/latest --jq .tag_name)
echo "## Latest Experimental Release"
if [ -n "$LAST_TAG" ] && [ "$LAST_TAG" != "null" ]; then
    RELEASE_URL="https://github.com/h0tp-ftw/ankimon/releases/download/${LAST_TAG}/ankimon-${LAST_TAG}-anki21-ankiweb.ankiaddon"
    echo "Latest Tag: \`$LAST_TAG\`"
    echo "Download Link: [ankimon-${LAST_TAG}.ankiaddon]($RELEASE_URL)"
    echo ""
    echo "### Usage Instructions"
    echo "- **Fixed Issues**: If an issue is already fixed in this version, **directly provide the download link provided above** in your response to the user. Encourage users who are on the outdated AnkiWeb version to upgrade to this Experimental version to receive the latest fixes and features immediately."
else
    echo "No tags found to generate release link."
fi
exit 0
