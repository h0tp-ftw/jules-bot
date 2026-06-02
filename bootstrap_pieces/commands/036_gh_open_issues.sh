#!/bin/bash
echo "## Open Issues"
ISSUES_JSON=$(gh issue list -R h0tp-ftw/ankimon --state open --json number,title,author,labels --limit 20)
if [ "$ISSUES_JSON" == "[]" ] || [ -z "$ISSUES_JSON" ]; then
    echo "*No open issues.*"
else
    echo "$ISSUES_JSON" | jq -c '.[]' | while read -r issue; do
        num=$(echo "$issue" | jq -r '.number')
        title=$(echo "$issue" | jq -r '.title')
        author=$(echo "$issue" | jq -r '.author.login')
        LABELS=$(echo "$issue" | jq -r '.labels[].name' | tr '\n' ',' | sed 's/,$//')
        LABEL_DETAILS=""
        if [ -n "$LABELS" ]; then
            LABEL_DETAILS=" [labels: $LABELS]"
        fi
        echo "- #$num - $title (@$author)$LABEL_DETAILS"
    done
fi
exit 0
