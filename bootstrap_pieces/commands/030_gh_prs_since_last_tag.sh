#!/bin/bash
LAST_TAG=$(gh api repos/h0tp-ftw/ankimon/releases/latest --jq .tag_name)
if [ -z "$LAST_TAG" ] || [ "$LAST_TAG" == "null" ]; then
    echo "## GitHub PRs since last release"
    echo "No releases found on GitHub."
    exit 0
fi
TAG_DATE=$(gh api repos/h0tp-ftw/ankimon/releases/latest --jq .published_at)
echo "## GitHub PRs since $LAST_TAG"
echo "Last release tag: \`$LAST_TAG\` (published at $TAG_DATE)"
echo "> [!IMPORTANT]"
echo "> The following changes have been merged into \`main\` AFTER the release tag. Since Jules is on the \`main\` branch, these changes **ARE AVAILABLE** in the codebase you are currently seeing."
echo "> **However**, the user is likely still on the release tag (\`$LAST_TAG\`), so they may not have these features or fixes yet."
echo ""
PRS_JSON=$(gh pr list -R h0tp-ftw/ankimon --state merged --search "merged:>$TAG_DATE" --json number,title,author --limit 50)
if [ "$PRS_JSON" == "[]" ] || [ -z "$PRS_JSON" ]; then
    echo "*No new PRs merged since this release.*"
else
    echo "### Merged Pull Requests (Included in your current view)"
    echo "$PRS_JSON" | jq -c '.[]' | while read -r pr; do
        num=$(echo "$pr" | jq -r '.number')
        title=$(echo "$pr" | jq -r '.title')
        author=$(echo "$pr" | jq -r '.author.login')
        FILES_JSON=$(gh pr view "$num" -R h0tp-ftw/ankimon --json files)
        FILE_COUNT=$(echo "$FILES_JSON" | jq '.files | length')
        FILE_DETAILS=""
        if [ "$FILE_COUNT" -lt 10 ]; then
            FILE_LIST=$(echo "$FILES_JSON" | jq -r '.files[].path' | sed 's|.*/||' | tr '\n' ',' | sed 's/,$//')
            FILE_DETAILS=" [$FILE_COUNT files: $FILE_LIST]"
        else
            DISPLAY_COUNT="$FILE_COUNT"
            [ "$FILE_COUNT" -eq 100 ] && DISPLAY_COUNT="100+"
            FILE_DETAILS=" [$DISPLAY_COUNT files modified]"
        fi
        echo "- #$num - $title (@$author)$FILE_DETAILS"
    done
fi
exit 0
