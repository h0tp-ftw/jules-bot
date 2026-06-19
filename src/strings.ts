// Central catalog of every user-facing string and substantive Jules-prompt
// fragment in the bot. THESE ARE THE DEFAULTS — the single source of truth.
//
// Any of them can be overridden globally or per-channel / per-thread / per-role
// via a `messages:` block in config.yaml, resolved through getEffectiveConfig()
// (precedence: defaults -> global YAML -> parent channel -> thread -> role).
//
// Do NOT hardcode user-facing text in other modules — add it here and reference
// it via `cfg.messages.*` (thread context) or the global `MESSAGES` (no context).
//
// Templated strings use {placeholder} tokens that are filled at runtime by t().
// e.g. t(MESSAGES.session.initializing, { emoji, repo, branch }).

export const DEFAULT_MESSAGES = {
  // Generic errors shown directly to Discord users.
  errors: {
    guild_only: '❌ This command can only be used in a server.',
    no_permission_commands: '❌ **You do not have permission to run bot commands.**',
    no_permission_session: '❌ **You do not have permission to interact with this diagnostic session.**',
    no_permission_interaction: '❌ **You do not have permission to interact with this session.**',
    command_execution_error: '❌ **There was an error executing this command:**\n```\n{error}\n```',
    session_not_found: '❌ Session not found.',
    repo_not_found: '❌ Selected repository not found.',
    jules_communication_error: '❌ **An error occurred while communicating with Jules.**',
    session_setup_error: '❌ **An error occurred while setting up the session.**',
  },

  // Session lifecycle messages posted into the thread.
  session: {
    initializing: '{emoji} **Initializing diagnostic Jules session...**\nRunning analysis against repository: `{repo}` on branch `{branch}`...',
    start_failed: '❌ **Failed to start Jules diagnostic session. Please verify your repository configuration and permissions.**',
    starter_message_unavailable: '⚠️ **Could not retrieve the starter message for this thread. Please reply with your issue details to start.**',
    queued_timeout: '⚠️ Jules session timed out waiting to start. Please open a new thread.',
    analysis_failed_retries: '❌ **The diagnostic analysis session failed after multiple reconnection attempts:**\n```\n{error}\n```',
    prewarming_wait: '⏳ **A session is currently pre-warming. Waiting for it to become ready...**',
    prewarmed_ready: '🚀 **Ready session found! Processing your issue...**',
    message_delivery_failed: '❌ **Failed to deliver message to Jules. Please make sure the session is still active.**',
    default_title: 'Diagnostic Session',
  },

  // Interactive repository / branch selection UI.
  setup: {
    configure_select_repo: '📋 **Configure Jules Diagnostic Session**\nPlease select the repository you want to run diagnostics against:',
    configure_select_branch: '📋 **Configure Jules Diagnostic Session**\nSelected Repository: `{repo}`\nPlease select the branch to work on:',
    configure_select_branch_search: '📋 **Configure Jules Diagnostic Session**\nSelected Repository: `{repo}` (Search results for: `{query}`)\nPlease select the branch to work on:',
    no_connected_repos: '⚠️ **No connected repositories found in your Jules account.** Please connect a repository first.',
    load_repos_failed: '❌ **Failed to load connected repositories for selection.** Please verify your connection to Google Jules and try again.',
    no_default_repo: '⚠️ **No default repository has been set for this server.** Please use the `/link-repo` command to set a default repository.',
    no_branches_matched: '❌ **No branches matched your search query "{query}".** Please try again.',
    repo_select_placeholder: 'Choose a repository...',
    branch_select_placeholder: 'Choose a branch...',
    branch_search_results_placeholder: 'Search results for "{query}"...',
    default_repo_option: '⭐ Default: {repo}',
    default_branch_option: '⭐ Default: {branch}',
    search_branches_option: '🔍 Search Branches...',
    custom_branch_option: '✍️ Enter Custom Branch...',
    search_again_option: '🔍 Search Again...',
    clear_search_option: '❌ Clear Search / Reset',
    search_modal_title: 'Search Branches',
    search_modal_input_label: 'Branch Name or Search Keyword',
    search_modal_input_placeholder: 'e.g. feature/auth, main, develop',
    custom_branch_modal_title: 'Enter Custom Branch',
    custom_branch_modal_input_label: 'Exact Branch Name',
    custom_branch_modal_input_placeholder: 'e.g. feature/cool-stuff',
  },

  // Diagnostic plan embed, buttons, and approval / rejection notices.
  plan: {
    embed_title: '{emoji} Jules Proposed Diagnostic Plan',
    embed_no_details: 'No details provided.',
    step_line: '**{number}.** {title}',
    welcome_footer: 'Welcome plan detected.',
    approve_button: 'Approve Plan',
    reject_button: 'Reject Plan',
    approved: '✅ **Plan approved. Jules is continuing the diagnostic steps...**',
    approved_via_command: '✅ **Plan approved via slash command! Jules is continuing the diagnostic steps...**',
    rejected: '❌ **Plan rejected. Please describe the changes or alternative approach you want Jules to take.**',
    auto_rejected_notice: '{emoji} **Plan Automatically Rejected:**\nFeedback: "{feedback}"\nJules is revising the plan...',
  },

  // Streamed status message (StreamManager). The status message is assembled
  // from these fragments; structural newlines/fences live in the code.
  stream: {
    initial_status: '{emoji} **Jules is analyzing the workspace...**\n\n*Logs will stream below:*',
    analyzing_header: '{emoji} **Jules is analyzing the workspace...**',
    current_step: '⚡ **Current Step:**\n> **{title}**',
    current_step_description: '> *{description}*',
    execution_logs_header: '**Execution Logs:**',
    completed: '✅ **Jules analysis completed successfully.**',
    failed: '❌ **Jules analysis failed.**',
    failed_reason_suffix: ' Reason: {reason}',
    final_logs_header: '**Final execution logs:**',
  },

  // Slash-command descriptions (Discord command picker) + command replies.
  commands: {
    approve_description: 'Approve the proposed plan for this diagnostic session',
    approve_thread_only: '❌ This command can only be used inside a Jules diagnostic thread.',
    approve_no_active_session: '❌ No active Jules session found for this thread.',
    approve_cannot_approve_state: '❌ **Cannot approve plan.** Current session state is `{state}` (needs to be `awaitingPlanApproval`).',
    approve_failed: '❌ **Failed to approve plan. An error occurred while communicating with Jules.**',
    link_repo_description: 'Link a GitHub repository to this server as the default for Jules diagnostic sessions',
    link_repo_option_description: 'GitHub repository in owner/repo format (e.g. facebook/react)',
    link_repo_invalid_format: '❌ Invalid repository format. Please use `owner/repo` format (e.g., `facebook/react`).',
    link_repo_success: '✅ **Successfully linked repository `{repo}` to this server!** Jules will now analyze this repository for new debug threads.',
    link_repo_failed: '❌ Failed to link repository in the database.',
    setup_forum_description: 'Set the designated Forum channel where Jules will monitor debug threads',
    setup_forum_option_description: 'The Forum channel to monitor',
    setup_forum_success: '✅ **Successfully set debug forum channel to <#{channel}>!** Any new threads created here will initialize a Jules session.',
    setup_forum_failed: '❌ Failed to save forum channel configuration in the database.',
  },

  // Substantive prompt fragments sent to the Jules agent. (Trivial structural
  // glue such as "User Issue:" lives inline in JulesClient/PreWarmedManager.)
  prompts: {
    metadata_header: '[Message details - Author Nickname: {nickname}, Author Username: {username}, Author Discord ID: {id}, Message Time: {time}]\n\n{content}',
    metadata_header_with_title: '[Message details - Author Nickname: {nickname}, Author Username: {username}, Author Discord ID: {id}, Message Time: {time}, Issue/Thread Title: {title}]\n\n{content}',
    auto_reject_default: 'Please do not create or refine an implementation plan. Instead, just talk directly with me to understand the goals and discuss the issue.',
    auto_reject_directive_welcome: '[System Directive: Auto-Reject Plan]\nFeedback: "{feedback}"\n\nPlease do not create or refine an implementation plan. Respond directly to the user\'s prompt.',
    auto_reject_directive_prewarm: '[System Directive: Auto-Reject Plan]\nFeedback: "{feedback}"\n\nPlease do not create or refine an implementation plan. Respond directly to the previous prompt and do not try to refine the implementation plan.',
    prewarm_default: 'You are a diagnostic assistant. The user is connecting and has just sent their initial response. Acknowledge that you are showing this message now that they have replied. Share an extremely obscure, niche, or lesser-known Pokémon trivia fact (avoiding common, generic facts), and let them know you are actively analyzing the codebase and working on their query right now. Even though you don\'t see their query yet, respond as if you have received a query from the user and are working on it. Do NOT propose code changes yet; generate the initial plan to welcome them and begin investigation.',
    prewarm_title: 'Pre-warmed Session ({repo})',
    prewarm_title_context: 'Pre-warmed Session ({repo} - Context: {context})',
  },

  // Attachment metadata block appended to user messages for Jules.
  attachments: {
    header: '\n\n📎 **Attachments Attached:**\n',
    item: '- **Name:** `{name}`\n  **URL:** {url}\n',
    type: '  **Type:** `{type}`\n',
    size: '  **Size:** `{size} KB`\n',
    instructions: '\n*(Note to Jules: If you need to inspect or analyze the attachments listed above, you should download them inside your workspace. For example, you can run `curl -o "filename" "URL"` or use a download script to save the file. Once downloaded locally in your workspace, you can use your native read/view tools on the downloaded file. If it is an image or PDF, your native read tool can handle it multimodally.)*\n',
  },

  // Miscellaneous.
  misc: {
    custom_status_name: 'Custom Status',
  },
}

// The shape of the message catalog. Inferred from DEFAULT_MESSAGES (no `as const`
// so leaves are plain `string`), giving call sites autocomplete + key checking
// while letting overrides supply any string.
export type Messages = typeof DEFAULT_MESSAGES

function isPlainObject(v: any): v is Record<string, any> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/**
 * Recursively merges one or more partial override trees over a base. Only
 * plain-object branches recurse; any other value (string/number/array) from a
 * later override replaces the earlier value. `undefined` overrides are ignored,
 * so a partial override (e.g. just `messages.errors.session_not_found`) leaves
 * every other default intact. Returns a fresh object — inputs are not mutated.
 */
export function deepMergeMessages(base: any, ...overrides: any[]): any {
  let out: any = isPlainObject(base) ? { ...base } : base
  for (const override of overrides) {
    if (!isPlainObject(override)) continue
    if (!isPlainObject(out)) {
      out = { ...override }
      continue
    }
    for (const key of Object.keys(override)) {
      const ov = override[key]
      if (ov === undefined) continue
      const bv = out[key]
      out[key] = isPlainObject(bv) && isPlainObject(ov) ? deepMergeMessages(bv, ov) : ov
    }
  }
  return out
}

/**
 * Fills {placeholder} tokens in a template string from `vars`. Single-pass:
 * substituted values are never re-scanned, so user/agent text containing
 * literal braces is safe. Unknown or null/undefined placeholders are left
 * untouched.
 */
export function t(template: string, vars?: Record<string, string | number | null | undefined>): string {
  if (!template || !vars) return template
  return template.replace(/\{(\w+)\}/g, (match, key) => {
    const v = vars[key]
    return v === undefined || v === null ? match : String(v)
  })
}
