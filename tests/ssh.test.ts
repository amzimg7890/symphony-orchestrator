import { describe, expect, it } from 'vitest'
import { buildSshArgs } from '../src/server/symphony/ssh'

describe('SSH command helpers', () => {
  it('splits host:port shorthand while preserving user and bracketed IPv6 targets', () => {
    const previousConfig = process.env.SYMPHONY_SSH_CONFIG
    process.env.SYMPHONY_SSH_CONFIG = '/tmp/symphony-ssh-config'
    try {
      expect(buildSshArgs('localhost:2222', 'printf ok')).toEqual([
        '-F',
        '/tmp/symphony-ssh-config',
        '-T',
        '-p',
        '2222',
        'localhost',
        "bash -lc 'printf ok'",
      ])
      expect(buildSshArgs('root@127.0.0.1:2200', 'printf ok')).toEqual([
        '-F',
        '/tmp/symphony-ssh-config',
        '-T',
        '-p',
        '2200',
        'root@127.0.0.1',
        "bash -lc 'printf ok'",
      ])
      expect(buildSshArgs('root@[::1]:2200', 'printf ok')).toEqual([
        '-F',
        '/tmp/symphony-ssh-config',
        '-T',
        '-p',
        '2200',
        'root@[::1]',
        "bash -lc 'printf ok'",
      ])
      expect(buildSshArgs('::1:2200', 'printf ok')).toEqual([
        '-F',
        '/tmp/symphony-ssh-config',
        '-T',
        '::1:2200',
        "bash -lc 'printf ok'",
      ])
    } finally {
      restoreEnv('SYMPHONY_SSH_CONFIG', previousConfig)
    }
  })
})

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name]
  } else {
    process.env[name] = value
  }
}
