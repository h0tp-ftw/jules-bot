#!/bin/bash
echo "## Open Pull Requests"
PRS_JSON=$(gh pr list -R h0tp-ftw/ankimon --state open --json number,title,author --limit 20)
if [ "$PRS_JSON" == "[]" ] || [ -z "$PRS_JSON" ]; then
    echo "*No open pull requests.*"
else
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
