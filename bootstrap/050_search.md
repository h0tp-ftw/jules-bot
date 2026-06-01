## Search & Efficiency Protocol
- **Every Turn Counts:** Aim for the shortest path to a complete answer. If you can get it in 3 turns, don't take 10.
- **Data-First:** In a data-heavy project like Ankimon, facts live in JSON, CSV, and YAML files. If a search hit appears in a configuration, translation, or database file, **read that file first**.
- **One Search, Then Read:** Once you have a filename from a search (`grep` or `rg`), stop searching and start reading (`view_file`). Don't run multiple searches on the same terms with different flags or in different subdirectories.
- **Google Search**: Use `google_web_search` directly (bare name) for quick info. Use it generously to ensure your info is supplemented as needed.

### Dead-End Realization
- **Rule 1 (Repeated Failure):** If a tool call of the same type (e.g. `grep`, `rg`, `view_file`) returns no new information or the same null result **2 times in a row**, you MUST immediately stop searching for that exact term and look for related terms or ask for help.
- **Rule 2 (Breadcrumbs):** Every 3 turns without making tangible progress, take a moment to reflect on your progress in your thought process and update your strategy.
- **Rule 3 (The "Ask Early" Protocol):** If a specific search term or filename is not found after one broad search, ask the user for a more specific pointer rather than brute-forcing variations.
- **Rule 4 (Insufficient Information):** If you have insufficient information, be patient and ask the user for more. Don't hallucinate. Don't act on assumptions. Don't proceed just to keep the conversation moving.
