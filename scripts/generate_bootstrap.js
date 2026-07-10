import fs from 'fs'
import path from 'path'
import { execSync } from 'child_process'

const bootstrapDir = path.resolve('bootstrap')
const templatePath = path.resolve('templates/soul_template.md')

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

if (!fs.existsSync(templatePath)) {
  console.error(`❌ Template file not found at: ${templatePath}`)
  process.exit(1)
}

let templateContent = fs.readFileSync(templatePath, 'utf8')

console.log('\n⚙️ Fetching data from GitHub and populating soul template...')

// Helper to run gh commands safely
function runGh(args) {
  try {
    return execSync(`gh ${args}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim()
  } catch (err) {
    console.error(`Failed to run gh ${args}:`, err.message)
    return ''
  }
}

// 2. Fetch Latest Release Info
let latestReleaseTagAndDownloadLink = 'No release tag found.'
let tagDate = ''
try {
  const releaseInfoRaw = runGh('api repos/h0tp-ftw/ankimon/releases/latest')
  if (releaseInfoRaw) {
    const release = JSON.parse(releaseInfoRaw)
    const lastTag = release.tag_name
    tagDate = release.published_at
    const releaseUrl = `https://github.com/h0tp-ftw/ankimon/releases/download/${lastTag}/ankimon-${lastTag}-anki21-ankiweb.ankiaddon`

    latestReleaseTagAndDownloadLink = `Latest Tag: \`${lastTag}\`\nDownload Link: [ankimon-${lastTag}.ankiaddon](${releaseUrl})`
  }
} catch (err) {
  console.error('Failed to fetch latest release info:', err)
}

// 3. Fetch Merged PRs Since Last Tag
let mergedPrsSinceTag = '*No new PRs merged since this release.*'
if (tagDate) {
  try {
    const prsRaw = runGh(
      `pr list -R h0tp-ftw/ankimon --state merged --search "merged:>${tagDate}" --json number,title,author --limit 50`,
    )
    if (prsRaw && prsRaw !== '[]') {
      const prs = JSON.parse(prsRaw)
      let md = `Last release tag published at: ${tagDate}\n\n`
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
      mergedPrsSinceTag = md.trim()
    }
  } catch (err) {
    console.error('Failed to fetch merged PRs since tag:', err)
  }
}

// 4. Fetch Open PRs
let openPrs = '*No open pull requests.*'
try {
  const prsRaw = runGh(
    `pr list -R h0tp-ftw/ankimon --state open --json number,title,author --limit 20`,
  )
  if (prsRaw && prsRaw !== '[]') {
    const prs = JSON.parse(prsRaw)
    let md = ''
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
    openPrs = md.trim()
  }
} catch (err) {
  console.error('Failed to fetch open PRs:', err)
}

// 5. Fetch Open Issues
let openIssues = '*No open issues.*'
try {
  const issuesRaw = runGh(
    `issue list -R h0tp-ftw/ankimon --state open --json number,title,author,labels --limit 20`,
  )
  if (issuesRaw && issuesRaw !== '[]') {
    const issues = JSON.parse(issuesRaw)
    let md = ''
    for (const issue of issues) {
      const labels = (issue.labels || []).map((l) => l.name).join(',')
      const labelDetails = labels ? ` [labels: ${labels}]` : ''
      md += `- #${issue.number} - ${issue.title} (@${issue.author.login})${labelDetails}\n`
    }
    openIssues = md.trim()
  }
} catch (err) {
  console.error('Failed to fetch open issues:', err)
}

// Replace placeholders in the template
let outputContent = templateContent
  .replace('{{LATEST_RELEASE_TAG_AND_DOWNLOAD_LINK}}', latestReleaseTagAndDownloadLink)
  .replace('{{MERGED_PRS_SINCE_TAG}}', mergedPrsSinceTag)
  .replace('{{OPEN_PRS}}', openPrs)
  .replace('{{OPEN_ISSUES}}', openIssues)

// 6. Write populated soul.md to bootstrap/010_soul.md
try {
  const destPath = path.join(bootstrapDir, '010_soul.md')
  fs.writeFileSync(destPath, outputContent, 'utf8')
  console.log(`+ Generated: 010_soul.md from template`)
} catch (err) {
  console.error('Failed to write 010_soul.md:', err)
}

console.log('\n🎉 Bootstrap generation complete!')
