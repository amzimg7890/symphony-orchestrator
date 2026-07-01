import { describe, expect, it } from 'vitest'
import { parseDiscordMessageUrl, withHermesMarker } from '../scripts/create-hermes-issue'

describe('Hermes issue creation helpers', () => {
  it('parses a Discord message URL', () => {
    expect(parseDiscordMessageUrl('https://discord.com/channels/111/222222/333333')).toEqual({
      guild_id: '111',
      channel_id: '222222',
      thread_id: '222222',
      message_id: '333333',
    })
  })

  it('adds a Hermes marker to an issue body', () => {
    const body = withHermesMarker(
      'Task:\nDo the thing.',
      {
        guild_id: '111',
        channel_id: '222222',
        thread_id: '222222',
        message_id: '333333',
      },
      'intake',
    )

    expect(body).toContain('<!-- hermes:{"source":"discord","channel_id":"222222","thread_id":"222222","message_id":"333333","profile":"intake"} -->')
    expect(body).toContain('Task:\nDo the thing.')
  })
})
