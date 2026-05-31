import { jules } from '@google/jules-sdk'
import { JULES_API_KEY } from './src/config.js'

async function main() {
  console.log('Jules API Key:', JULES_API_KEY)
  const client = jules.with({ apiKey: JULES_API_KEY })
  
  console.log('Attempting to create session for h0tp-ftw/ankimon...')
  try {
    const session = await client.session({
      prompt: 'Check codebase and tell me what the project is about.',
      source: { github: 'h0tp-ftw/ankimon', baseBranch: 'main' },
      title: 'Diagnostics Test',
      requireApproval: true,
    })
    console.log('Created Session ID:', session.id)
    console.log('Session URL:', (session as any).url)
    
    console.log('Polling session state...')
    let info = await session.info()
    console.log('Current state:', info.state)
    
    // Poll for up to 2 minutes (12 attempts, 10s delay)
    for (let i = 0; i < 12; i++) {
      if (info.state !== 'queued') {
        break
      }
      console.log(`[Attempt ${i + 1}] Session is still queued. Waiting 10s...`)
      await new Promise((resolve) => setTimeout(resolve, 10000))
      info = await session.info()
      console.log('Current state:', info.state)
    }

    console.log('Final state before streaming:', info.state)

    console.log('Streaming activities...')
    for await (const activity of session.stream()) {
      console.log('Activity type:', activity.type)
      if (activity.type === 'planGenerated') {
        console.log('Plan:', (activity as any).plan)
      }
    }
  } catch (err) {
    console.error('Test Failed:', err)
  }
}

main()
