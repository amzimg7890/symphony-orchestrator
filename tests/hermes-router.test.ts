import { describe, expect, it } from 'vitest'
import { buildIssueBody, parseIntakeCommand, titleFromRequest } from '../scripts/hermes-router'

describe('Hermes router helpers', () => {
  it('parses intake commands', () => {
    expect(parseIntakeCommand('!hermes intake 修首页提示')?.request).toBe('修首页提示')
    expect(parseIntakeCommand('/hermes intake\n修首页提示')?.request).toBe('修首页提示')
    expect(parseIntakeCommand('<@123456> intake 修首页提示')?.request).toBe('修首页提示')
    expect(parseIntakeCommand('hello')).toBeNull()
  })

  it('derives a short issue title', () => {
    expect(titleFromRequest('# 修首页提示\n更多内容')).toBe('修首页提示')
  })

  it('builds an issue body with Discord source marker', () => {
    const body = buildIssueBody('修首页提示', {
      id: '333333',
      channel_id: '222222',
      guild_id: '111111',
      content: '!hermes intake 修首页提示',
    })

    expect(body).toContain('<!-- hermes:{"source":"discord","channel_id":"222222","thread_id":"222222","message_id":"333333","profile":"intake"} -->')
    expect(body).toContain('https://discord.com/channels/111111/222222/333333')
    expect(body).toContain('修首页提示')
  })
})
