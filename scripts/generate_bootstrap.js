import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'

const bootstrapDir = path.resolve('bootstrap')
const piecesDir = path.resolve('bootstrap_pieces')
const staticDir = path.join(piecesDir, 'static')

console.log('🧹 Cleaning old bootstrap markdown files...')

// 1. Delete all markdown files in bootstrap/
if (fs.existsSync(bootstrapDir)) {
  const files = fs.readdirSync(bootstrapDir)
  for (const file of files) {
    if (file.endsWith('.md')) {
      const filePath = path.join(bootstrapDir, file)
      fs.unlinkSync(filePath)
      console.log(`- Deleted: ${file}`)
    }
  }
} else {
  fs.mkdirSync(bootstrapDir, { recursive: true })
}

// 2. Copy static files
if (fs.existsSync(staticDir)) {
  console.log('\n📝 Copying static bootstrap files...')
  const staticFiles = fs.readdirSync(staticDir)
  for (const file of staticFiles) {
    if (file.endsWith('.md')) {
      const src = path.join(staticDir, file)
      const dest = path.join(bootstrapDir, file)
      fs.copyFileSync(src, dest)
      console.log(`+ Copied: ${file}`)
    }
  }
}

console.log('\n⚙️ Fetching data from GitHub and generating commands markdown...')

// Helper to run gh commands safely
function runGh(args) {
  try {
    return execSync(`gh ${args}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim()
  } catch (err) {
    console.error(`Failed to run gh ${args}:`, err.message)
    return ''
  }
}

// 3. Generate zz_cmd_030_gh_prs_since_last_tag.md
try {
  console.log('> Generating zz_cmd_030_gh_prs_since_last_tag.md...')
  const releaseInfoRaw = runGh('api repos/h0tp-ftw/ankimon/releases/latest')
  if (releaseInfoRaw) {
    const release = JSON.parse(releaseInfoRaw)
    const lastTag = release.tag_name
    const tagDate = release.published_at

    let md = `## GitHub PRs since ${lastTag}\n`
    md += `Last release tag: \`${lastTag}\` (published at ${tagDate})\n`
    md += `> [!IMPORTANT]\n`
    md += `> The following changes have been merged into \`main\` AFTER the release tag. Since Jules is on the \`main\` branch, these changes **ARE AVAILABLE** in the codebase you are currently seeing.\n`
    md += `> **However**, the user is likely still on the release tag (\`${lastTag}\`), so they may not have these features or fixes yet.\n\n`

    const prsRaw = runGh(
      `pr list -R h0tp-ftw/ankimon --state merged --search "merged:>${tagDate}" --json number,title,author --limit 50`,
    )
    if (prsRaw && prsRaw !== '[]') {
      const prs = JSON.parse(prsRaw)
      md += `### Merged Pull Requests (Included in your current view)\n`
      for (const pr of prs) {
        const prViewRaw = runGh(`pr view ${pr.number} -R h0tp-ftw/ankimon --json files`)
        let fileDetails = ''
        if (prViewRaw) {
          const files = JSON.parse(prViewRaw).files || []
          if (files.length < 10) {
            const fileList = files.map((f) => f.path.split('/').pop()).join(',')
            fileDetails = ` [${files.length} files: ${fileList}]`
          } else {
            const displayCount = files.length === 100 ? '100+' : files.length
            fileDetails = ` [${displayCount} files modified]`
          }
        }
        md += `- #${pr.number} - ${pr.title} (@${pr.author.login})${fileDetails}\n`
      }
    } else {
      md += `*No new PRs merged since this release.*\n`
    }
    fs.writeFileSync(path.join(bootstrapDir, 'zz_cmd_030_gh_prs_since_last_tag.md'), md)
    console.log('+ Generated: zz_cmd_030_gh_prs_since_last_tag.md')
  }
} catch (err) {
  console.error('Failed to generate PRs since last tag:', err)
}

// 4. Generate zz_cmd_035_gh_open_prs.md
try {
  console.log('> Generating zz_cmd_035_gh_open_prs.md...')
  let md = `## Open Pull Requests\n`
  const prsRaw = runGh(
    `pr list -R h0tp-ftw/ankimon --state open --json number,title,author --limit 20`,
  )
  if (prsRaw && prsRaw !== '[]') {
    const prs = JSON.parse(prsRaw)
    for (const pr of prs) {
      const prViewRaw = runGh(`pr view ${pr.number} -R h0tp-ftw/ankimon --json files`)
      let fileDetails = ''
      if (prViewRaw) {
        const files = JSON.parse(prViewRaw).files || []
        if (files.length < 10) {
          const fileList = files.map((f) => f.path.split('/').pop()).join(',')
          fileDetails = ` [${files.length} files: ${fileList}]`
        } else {
          const displayCount = files.length === 100 ? '100+' : files.length
          fileDetails = ` [${displayCount} files modified]`
        }
      }
      md += `- #${pr.number} - ${pr.title} (@${pr.author.login})${fileDetails}\n`
    }
  } else {
    md += `*No open pull requests.*\n`
  }
  fs.writeFileSync(path.join(bootstrapDir, 'zz_cmd_035_gh_open_prs.md'), md)
  console.log('+ Generated: zz_cmd_035_gh_open_prs.md')
} catch (err) {
  console.error('Failed to generate open PRs:', err)
}

// 5. Generate zz_cmd_036_gh_open_issues.md
try {
  console.log('> Generating zz_cmd_036_gh_open_issues.md...')
  let md = `## Open Issues\n`
  const issuesRaw = runGh(
    `issue list -R h0tp-ftw/ankimon --state open --json number,title,author,labels --limit 20`,
  )
  if (issuesRaw && issuesRaw !== '[]') {
    const issues = JSON.parse(issuesRaw)
    for (const issue of issues) {
      const labels = (issue.labels || []).map((l) => l.name).join(',')
      const labelDetails = labels ? ` [labels: ${labels}]` : ''
      md += `- #${issue.number} - ${issue.title} (@${issue.author.login})${labelDetails}\n`
    }
  } else {
    md += `*No open issues.*\n`
  }
  fs.writeFileSync(path.join(bootstrapDir, 'zz_cmd_036_gh_open_issues.md'), md)
  console.log('+ Generated: zz_cmd_036_gh_open_issues.md')
} catch (err) {
  console.error('Failed to generate open issues:', err)
}

// 6. Generate zz_cmd_040_ankimon_release_link.md
try {
  console.log('> Generating zz_cmd_040_ankimon_release_link.md...')
  const releaseInfoRaw = runGh('api repos/h0tp-ftw/ankimon/releases/latest')
  let md = `## Latest Experimental Release\n`
  if (releaseInfoRaw) {
    const release = JSON.parse(releaseInfoRaw)
    const lastTag = release.tag_name
    const releaseUrl = `https://github.com/h0tp-ftw/ankimon/releases/download/${lastTag}/ankimon-${lastTag}-anki21-ankiweb.ankiaddon`

    md += `Latest Tag: \`${lastTag}\`\n`
    md += `Download Link: [ankimon-${lastTag}.ankiaddon](${releaseUrl})\n\n`
    md += `### Usage Instructions\n`
    md += `- **Fixed Issues**: If an issue is already fixed in this version, **directly provide the download link provided above** in your response to the user. Encourage users who are on the outdated AnkiWeb version to upgrade to this Experimental version to receive the latest fixes and features immediately.\n`
  } else {
    md += `No tags found to generate release link.\n`
  }
  fs.writeFileSync(path.join(bootstrapDir, 'zz_cmd_040_ankimon_release_link.md'), md)
  console.log('+ Generated: zz_cmd_040_ankimon_release_link.md')
} catch (err) {
  console.error('Failed to generate release link:', err)
}

console.log('\n🎉 Bootstrap generation complete!')
