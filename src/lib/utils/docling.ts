import { ThreadChannel } from 'discord.js'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'

const execFilePromise = promisify(execFile)

function getPythonExecutable(): string {
  const winPath = path.join(process.cwd(), '.venv', 'Scripts', 'python.exe')
  const unixPath = path.join(process.cwd(), '.venv', 'bin', 'python')
  
  if (os.platform() === 'win32') {
    return winPath
  }
  return unixPath
}

export interface SimpleAttachment {
  name: string
  url: string
  contentType?: string
  size?: number
}

/**
 * Downloads message attachments, runs them through Docling, and returns concatenated Markdown text.
 */
export async function processAttachments(
  attachments: SimpleAttachment[],
  thread: ThreadChannel
): Promise<string> {
  let parsedContent = ''
  
  for (const attachment of attachments) {
    const statusMsg = await thread.send(`⚙️ **Parsing attachment "${attachment.name}" with Docling...**`).catch(() => null)
    
    let tempFilePath = ''
    try {
      // 1. Download attachment
      const res = await fetch(attachment.url)
      if (!res.ok) {
        throw new Error(`Failed to download: HTTP ${res.status}`)
      }
      
      const arrayBuffer = await res.arrayBuffer()
      const buffer = Buffer.from(arrayBuffer)
      const tempDir = os.tmpdir()
      const ext = path.extname(attachment.name)
      const baseName = path.basename(attachment.name, ext)
      const tempFileName = `${baseName}_${Date.now()}${ext}`
      tempFilePath = path.join(tempDir, tempFileName)
      
      await fs.writeFile(tempFilePath, buffer)
      
      // 2. Call python script
      const pythonExe = getPythonExecutable()
      const scriptPath = path.join(process.cwd(), 'scripts', 'parse_document.py')
      
      const { stdout } = await execFilePromise(pythonExe, [scriptPath, tempFilePath], {
        maxBuffer: 20 * 1024 * 1024, // 20MB buffer
        timeout: 180000 // 180 seconds timeout
      })
      
      parsedContent += `\n\n---\n[Attachment: ${attachment.name}]\nConverted Content:\n${stdout.trim()}\n---\n`
    } catch (err: any) {
      console.error(`Failed to parse attachment ${attachment.name}:`, err)
      const errorMsg = err instanceof Error ? err.message : String(err)
      parsedContent += `\n\n---\n[Attachment: ${attachment.name}]\nFailed to convert this attachment. Error: ${errorMsg}\n---\n`
      await thread.send(`⚠️ **Failed to parse attachment "${attachment.name}". Error: ${errorMsg}**`).catch(() => null)
    } finally {
      // 3. Clean up temp file
      if (tempFilePath) {
        await fs.unlink(tempFilePath).catch((e) => {
          console.error(`Failed to clean up temp file ${tempFilePath}:`, e)
        })
      }
      if (statusMsg) {
        await statusMsg.delete().catch(() => {})
      }
    }
  }
  
  return parsedContent
}
