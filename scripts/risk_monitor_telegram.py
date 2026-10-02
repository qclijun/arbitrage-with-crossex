#!/usr/bin/env python3
"""Local Telegram setup helper. Never prints credentials or Telegram errors."""
import argparse
import sys
from pathlib import Path
from risk_monitor import ROOT, read_env, telegram


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['bot', 'chats', 'verify', 'test'])
    parser.add_argument('--env-file', default=str(ROOT / 'data/risk-monitor/telegram.env'))
    args = parser.parse_args()
    env = read_env(args.env_file)
    if args.command == 'bot':
        bot = telegram(env, 'getMe', {})
        print(bot['username'])
    elif args.command == 'chats':
        # Dedicated bot only: do not interfere with an existing webhook consumer.
        info = telegram(env, 'getWebhookInfo', {})
        if info.get('url'):
            raise RuntimeError('This bot uses a webhook. Use a dedicated monitor bot; webhook unchanged.')
        updates = telegram(env, 'getUpdates', {'limit': 100, 'timeout': 0})
        chats = {}
        for update in updates:
            chat = (update.get('message') or {}).get('chat', {})
            if chat.get('type') == 'private':
                chats[chat['id']] = chat
        if not chats:
            raise RuntimeError('No private chat found. Send /start to this bot, then retry.')
        for chat in chats.values():
            print('Chat ID:', chat['id'], 'Name:', chat.get('first_name', ''), 'Username:', chat.get('username', ''))
    else:
        chat_id = env.get('MONITOR_TELEGRAM_CHAT_ID', '')
        if not chat_id.isdigit():
            raise RuntimeError('A private Telegram chat ID is required.')
        chat = telegram(env, 'getChat', {'chat_id': chat_id})
        if chat.get('type') != 'private':
            raise RuntimeError('Only a confirmed private chat is supported.')
        if args.command == 'verify':
            print('Recipient:', chat.get('first_name', ''), 'Username:', chat.get('username', ''))
        else:
            telegram(env, 'sendMessage', {'chat_id': chat_id, 'text': '四腿风险监控测试：Telegram 通道已验证。检查频率默认5分钟，可配置。'})
            print('Test message confirmed by Telegram.')


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print('Setup failed:', str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__, file=sys.stderr)
        sys.exit(1)
