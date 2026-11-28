import test from 'node:test';
import assert from 'node:assert/strict';
import { fixturePluginAccount, selectPluginAccount } from './test-fixtures/plugin-account.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fork } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { ReplyDeliveryControls } from '../packages/dsh-social-bridge-plugin/reply-delivery-controls.mjs';
import { HistoryStore } from '../packages/dsh-social-bridge-plugin/history-store.mjs';
import { readVoiceAttempt } from '../packages/plugin-api/voice-status.mjs';

const projectRoot = path.resolve(process.env.WECHATAGENT_ENTRY_TEST_ROOT ?? path.join(import.meta.dirname, '..'));
const entry = path.join(projectRoot, 'components/qq-bridge/src/social-bridge.js');

if (process.argv[2] === '--bridge-entry-fixture') {
  // Discover the real listener's ephemeral port without replacing entry callbacks.
  const config = process.argv[3];
  const { ReverseOneBotServer } = await import(
    pathToFileURL(path.join(projectRoot, 'components/qq-bridge/src/onebot/reverse-ws-server.js'))
  );
  const start = ReverseOneBotServer.prototype.start;
  let port;
  ReverseOneBotServer.prototype.start = async function () {
    await start.call(this);
    port = this.server.address().port;
  };
  process.argv = [process.execPath, entry, config];
  await import(pathToFileURL(entry));
  process.on('message', message => {
    if (message === 'stop') process.emit('SIGTERM');
  });
  process.send({ ready: true, port });
} else {
  test(
    'real bridge entry dispatches private and group text, reloads reply limits, and scopes notebook routing',
    { timeout: 30000 },
    async t => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wechatagent-entry-'));
      selectPluginAccount(root);
      const voiceGeneration = 'fixture-speech-settings';
      const requests = [],
        sent = [],
        intakeReceipts = [],
        deliveryLookups = [];
      let child,
        ws,
        exited,
        logs = '',
        ready,
        healthHold,
        uncertainNext = false;
      const configFile = path.join(root, 'config/wechatagent.json');
      const server = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
        requests.push({ route: req.url, body });
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/health') {
          if (healthHold) {
            healthHold.seen = true;
            await healthHold.promise;
          }
          res.end(
            JSON.stringify({
              ok: true,
              project: 'WeChatAgent',
              projectRoot: root,
              accountScope: fixturePluginAccount,
              contextMode: 'native-session-v1',
              instanceId: 'entry-fixture',
              instanceStartedAt: Date.now(),
            }),
          );
        } else if (req.url === '/voice-input')
          res.end(
            JSON.stringify({
              ok: true,
              text: 'speech fixture transcript',
              plugin: 'speech-recognition',
              generation: voiceGeneration,
            }),
          );
        else if (req.url === '/followup')
          res.end(JSON.stringify({ text: 'RESPOND: Fixture reply ' + requests.length }));
        else if (req.url === '/diary-question')
          res.end(JSON.stringify({ handled: true, text: 'RESPOND: Fixture notebook reply' }));
        else {
          res.statusCode = 404;
          res.end('{}');
        }
      });
      t.after(async () => {
        healthHold?.resolve();
        ws?.close();
        if (child && child.exitCode === null && child.signalCode === null) {
          if (child.connected) child.send('stop');
          const force = setTimeout(() => child.kill(), 3000);
          try {
            await exited;
          } finally {
            clearTimeout(force);
          }
        }
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      });
      const until = async (check, label) => {
        const deadline = Date.now() + 10000;
        while (!check()) {
          assert(!/\berror=|ReferenceError|uncaughtException/.test(logs), logs);
          assert(!child || child.exitCode === null, 'bridge exited: ' + logs);
          assert(Date.now() < deadline, 'Timed out: ' + label + '\n' + logs);
          await delay(10);
        }
      };
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const wechat = {
        enabled: true,
        whitelist: { private: ['123'], groups: ['456@chatroom'] },
        wake_mode: 'hybrid',
        wake_words: ['助手'],
        replyLayout: { maxMessages: 0 },
        search: { enabled: false },
        stickers: { enabled: false },
        proactive: { enabled: false },
        context: { enabled: false },
      };
      const save = async () => {
        const temporary = configFile + '.tmp';
        fs.writeFileSync(temporary, JSON.stringify({ version: 1, wechat, persona: { default: 'Fixture', chats: {} } }));
        for (let attempt = 0; ; attempt++) {
          try {
            await fs.promises.rename(temporary, configFile);
            return;
          } catch (error) {
            if (attempt >= 10 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
            await delay(25);
          }
        }
      };
      fs.mkdirSync(path.dirname(configFile), { recursive: true });
      await save();
      const bridgeConfig = path.join(root, 'bridge.json');
      fs.writeFileSync(
        bridgeConfig,
        JSON.stringify({
          project_root: root,
          platforms: { wechat: { ...wechat, onebot: { server: { host: '127.0.0.1', port: 0, path: '/ws' } } } },
          role: 'Fixture persona',
          role_name: '',
          message_buffer: { path: path.join(root, 'state/messages.json') },
          search_policy_file: configFile,
          sticker_policy_file: configFile,
          proactive_policy_file: configFile,
          context_policy_file: configFile,
          proactive_state_file: path.join(root, 'state/proactive.json'),
          social: {
            batch_ms: 1,
            min_interval_ms: 0,
            private_min_interval_ms: 0,
            max_per_minute: 100,
            max_per_ten_minutes: 100,
          },
          dsh_plugin: { url: 'http://127.0.0.1:' + server.address().port, token: 'fixture-token' },
        }),
      );
      child = fork(import.meta.filename, ['--bridge-entry-fixture', bridgeConfig], {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: { ...process.env, SOCIAL_ONEBOT_TOKEN: '' },
      });
      exited = new Promise(resolve => child.once('exit', resolve));
      child.on('error', error => {
        logs += '\nuncaughtException ' + error.message;
      });
      child.stdout.on('data', chunk => {
        logs += chunk;
      });
      child.stderr.on('data', chunk => {
        logs += chunk;
      });
      child.on('message', message => {
        if (message.ready) ready = message;
      });
      await until(() => ready, 'entry startup');
      ws = new WebSocket('ws://127.0.0.1:' + ready.port + '/ws');
      ws.addEventListener('error', event => {
        logs += '\nuncaughtException ' + String(event.error ?? 'fixture WebSocket');
      });
      ws.addEventListener('message', event => {
        const action = JSON.parse(event.data);
        let data = { enabled: false, stickers: [], labels: [] };
        if (action.action === 'ack_wechatagent_intake') intakeReceipts.push(action.params.rawid);
        if (['send_private_msg', 'send_group_msg'].includes(action.action)) {
          sent.push(action);
          data = { receipt: 'wechat-server-id', message_id: sent.length };
        }
        if (uncertainNext && action.action === 'send_private_msg') {
          uncertainNext = false;
          ws.send(
            JSON.stringify({
              status: 'failed',
              retcode: 1407,
              message: 'TEXT_DELIVERY_UNCONFIRMED',
              data: { attempted: true },
              echo: action.echo,
            }),
          );
          return;
        }
        if (action.action === 'get_text_delivery') {
          deliveryLookups.push(action.params.wechatagent_delivery_id);
          data = { receipt: 'wechat-server-id', message_id: sent.length };
        }
        ws.send(JSON.stringify({ status: 'ok', retcode: 0, echo: action.echo, data }));
      });
      await until(() => ws.readyState === WebSocket.OPEN, 'OneBot connection');
      let sequence = 0;
      const send = async (kind, text) => {
        const count = sent.length;
        ws.send(
          JSON.stringify({
            post_type: 'message',
            message_type: kind,
            self_id: '999',
            user_id: '123',
            ...(kind === 'group' ? { group_id: '456@chatroom' } : {}),
            sender: { user_id: '123', nickname: 'Fixture' },
            message_id: ++sequence,
            time: Date.now() / 1000,
            message: [{ type: 'text', data: { text } }],
          }),
        );
        await until(() => sent.length === count + 1, 'confirmed reply');
        await until(() => logs.match(/delivery=confirmed/g)?.length === sent.length, 'recorded delivery');
      };
      const turns = () => requests.filter(item => ['/followup', '/diary-question'].includes(item.route));
      await send('private', 'hello fixture');
      assert.equal(turns().at(-1).body.conversationKey, 'wechat:private:123');
      assert.equal(turns().at(-1).body.replyMaxMessages, 0);
      assert.equal(turns().at(-1).body.fishNotebookRequest, undefined);
      wechat.replyLayout.maxMessages = 1;
      await save();
      await send('group', '助手 hello group');
      assert.equal(turns().at(-1).body.conversationKey, 'wechat:group:456@chatroom');
      assert.equal(turns().at(-1).body.replyMaxMessages, 1);
      const manifest = JSON.parse(
        fs.readFileSync(path.join(projectRoot, 'optional-extensions/fish-notebook/plugin.json'), 'utf8'),
      );
      fs.mkdirSync(path.join(root, 'plugins/fish-notebook'), { recursive: true });
      fs.writeFileSync(path.join(root, 'plugins/fish-notebook/plugin.json'), JSON.stringify(manifest));
      fs.writeFileSync(
        path.join(root, 'config/plugins.json'),
        JSON.stringify({
          version: 1,
          plugins: {
            'fish-notebook': {
              enabled: true,
              permissions: manifest.permissions,
              chatScopes: { [fixturePluginAccount]: { 'wechat:private:123': 'legacy' } },
            },
          },
        }),
      );
      wechat.replyLayout.maxMessages = 4;
      await save();
      await send('private', '看看你的日记');
      assert.equal(turns().at(-1).route, '/diary-question');
      assert.equal(turns().at(-1).body.replyMaxMessages, 4);
      assert.match(turns().at(-1).body.fishNotebookRequest.viewer, /^[a-f0-9]{64}$/);
      await send('group', '助手 看看你的日记');
      assert.equal(turns().at(-1).route, '/followup');
      assert.equal(turns().at(-1).body.fishNotebookRequest, undefined);
      assert.equal(turns().length, 4);
      assert.deepEqual(
        sent.map(item => item.action),
        ['send_private_msg', 'send_group_msg', 'send_private_msg', 'send_group_msg'],
      );
      const replay = (offlineReplay, digit) => {
        const rawid = digit.repeat(64);
        ws.send(
          JSON.stringify({
            post_type: 'message',
            message_type: 'private',
            self_id: '999',
            user_id: '123',
            time: Date.now() / 1000 - 86400,
            sender: { user_id: '123', nickname: 'Fixture' },
            message_id: rawid,
            message: [{ type: 'text', data: { text: 'Recovered fixture ' + digit } }],
            wechatagent: {
              readerIntake: {
                version: 1,
                rawid,
                token: 'a'.repeat(64),
                account: fixturePluginAccount,
                grant: 'legacy',
                offlineReplay,
              },
            },
          }),
        );
      };
      replay('context', '1');
      await until(() => intakeReceipts.length === 1, 'persisting a context-only message');
      assert.equal(sent.length, 4);
      replay('reply', '2');
      await until(() => intakeReceipts.length === 2 && sent.length === 5, 'one recovered reply');
      replay('reply', '2');
      await until(() => intakeReceipts.length === 3, 'acknowledging a replay after a lost receipt');
      assert.deepEqual(intakeReceipts, ['1'.repeat(64), '2'.repeat(64), '2'.repeat(64)]);
      assert.equal(sent.length, 5);
      assert.equal(turns().length, 5);
      assert.match(
        turns().at(-1).body.message,
        /<offline_chat_history>.*Recovered fixture 1.*<\/offline_chat_history>/,
      );
      const controls = new ReplyDeliveryControls(root, fixturePluginAccount),
        key = 'wechat:private:123',
        grant = controls.scope(key);
      controls.control({ key, grant, operation: 'pause', revision: 0 });
      const finalTurn = send('private', 'hold this fixture reply');
      await until(
        () => controls.list(key).replies.some(part => part.state === 'queued'),
        'operator hold before submission',
      );
      assert.equal(sent.length, 5);
      controls.control({ key, grant, operation: 'resume', revision: 1 });
      await finalTurn;
      assert.equal(sent.length, 6);
      uncertainNext = true;
      await send('private', 'check the original receipt');
      assert.equal(sent.length, 7);
      assert.deepEqual(deliveryLookups, [sent.at(-1).params.wechatagent_delivery_id]);

      wechat.whitelist.private.push('789');
      wechat.rosterGrants = { 'wechat:private:789': 'new-grant' };
      await save();
      const changedRosterEvent = (digit, grant) => {
        const rawid = digit.repeat(64);
        ws.send(
          JSON.stringify({
            post_type: 'message',
            message_type: 'private',
            self_id: '999',
            user_id: '789',
            sender: { user_id: '789', nickname: 'Fixture' },
            message_id: rawid,
            time: Date.now() / 1000,
            message: [{ type: 'text', data: { text: 'new roster fixture' } }],
            wechatagent: {
              readerIntake: { version: 1, rawid, token: 'a'.repeat(64), account: fixturePluginAccount, grant },
            },
          }),
        );
      };
      changedRosterEvent('3', 'new-grant');
      await until(() => intakeReceipts.includes('3'.repeat(64)) && sent.length === 8, 'first live-added chat reply');
      wechat.whitelist.private.pop();
      await save();
      changedRosterEvent('4', 'new-grant');
      await until(() => intakeReceipts.includes('4'.repeat(64)), 'discarding revoked input without blocking the inbox');
      assert.equal(sent.length, 8);
      const asr = 'speech-recognition',
        asrDir = path.join(root, 'plugins', asr);
      fs.mkdirSync(asrDir);
      fs.copyFileSync(
        path.join(projectRoot, 'optional-extensions', asr, 'plugin.json'),
        path.join(asrDir, 'plugin.json'),
      );
      fs.writeFileSync(
        path.join(root, 'config/plugins.json'),
        JSON.stringify({
          version: 1,
          plugins: {
            [asr]: {
              enabled: true,
              permissions: ['audio_read'],
              chatScopes: { [fixturePluginAccount]: { [key]: 'legacy' } },
              generation: voiceGeneration,
            },
          },
        }),
      );
      const rawid = '9'.repeat(64);
      ws.send(
        JSON.stringify({
          post_type: 'message',
          message_type: 'private',
          self_id: '999',
          user_id: '123',
          time: Date.now() / 1000 - 120,
          message_id: rawid,
          sender: { user_id: '123', nickname: 'Fixture' },
          message: [
            { type: 'text', data: { text: 'voice' } },
            { type: 'record', data: { file: 'wechatagent://voice/' + rawid, voice_id: rawid, duration: 2 } },
          ],
          wechatagent: {
            readerIntake: {
              version: 1,
              rawid,
              token: 'a'.repeat(64),
              account: fixturePluginAccount,
              grant: 'legacy',
              offlineReplay: 'reply',
              readerRole: 'social',
            },
          },
        }),
      );
      await until(() => intakeReceipts.includes(rawid) && sent.length === 9, 'transcribed recovered candidate');
      assert.equal(requests.filter(row => row.route === '/voice-input').length, 1);
      assert.match(turns().at(-1).body.message, /speech fixture transcript/);
      assert.equal(readVoiceAttempt(root, asr, voiceGeneration)?.ok, true);
      const admin = 'fixture_admin',
        target = admin,
        adminKey = 'wechat:private:' + target;
      const beforeAuthorization = Math.floor(Date.now() / 1000) - 180;
      wechat.whitelist.private.push(String(target));
      wechat.workModes = { [adminKey]: 'assistant' };
      wechat.assistant = {
        administrators: [admin],
        replayOffline: true,
        replayAuthorization: {
          since: beforeAuthorization + 1,
          administrators: [admin],
          chats: { [adminKey]: 'legacy' },
        },
      };
      await save();
      const emitAssistant = (digit, readerRole, { timestamp = beforeAuthorization + 60, live = false } = {}) => {
        const id = digit.repeat(64);
        ws.send(
          JSON.stringify({
            post_type: 'message',
            message_type: 'private',
            self_id: '999',
            user_id: target,
            sender: { user_id: target, nickname: 'Admin' },
            time: timestamp,
            message_id: id,
            message: [{ type: 'text', data: { text: 'fixture question' } }],
            wechatagent: {
              senderWxid: admin,
              readerIntake: {
                version: 1,
                rawid: id,
                token: 'a'.repeat(64),
                account: fixturePluginAccount,
                grant: 'legacy',
                ...(live ? {} : { offlineReplay: 'reply' }),
                readerRole,
              },
            },
          }),
        );
        return until(() => intakeReceipts.includes(id), 'assistant replay receipt');
      };
      const before = turns().length;
      await emitAssistant('a', 'assistant-member');
      await emitAssistant('d', 'assistant-admin', { timestamp: beforeAuthorization });
      await emitAssistant('b', 'assistant-admin');
      assert.equal(turns().length, before);
      const assistantHistory = JSON.parse(fs.readFileSync(path.join(root, 'state/messages.json'), 'utf8')).chats[
        adminKey
      ];
      assert.deepEqual(
        assistantHistory.map(row => [row.readerReplay, row.reply_skip_reason]),
        [
          ['context', 'reader_offline_context'],
          ['context', 'reader_offline_context'],
        ],
      );
      await emitAssistant('c', null, { timestamp: Math.floor(Date.now() / 1000), live: true });
      await until(() => turns().length === before + 1, 'new assistant request');
      assert.equal(turns().at(-1).body.assistantSender, admin);

      const groupTarget = '789@chatroom';
      const groupKey = 'wechat:group:' + groupTarget;
      const accountTarget = '345';
      const accountKey = 'wechat:private:' + accountTarget;
      wechat.whitelist.groups.push(groupTarget);
      wechat.whitelist.private.push(accountTarget);
      await save();
      const pauseIntake = async (kind, target, digit) => {
        const hold = (healthHold = Promise.withResolvers());
        const id = digit.repeat(64);
        ws.send(
          JSON.stringify({
            post_type: 'message',
            message_type: kind,
            self_id: '999',
            user_id: kind === 'private' ? target : 'fixture_member',
            ...(kind === 'group' ? { group_id: target } : {}),
            message_id: id,
            time: Math.floor(Date.now() / 1000),
            message: [{ type: 'text', data: { text: 'context fixture ' + digit } }],
            wechatagent: {
              contextOnly: true,
              readerIntake: { version: 1, rawid: id, token: id, account: fixturePluginAccount, grant: 'legacy' },
            },
          }),
        );
        await until(
          () => hold.seen && logs.includes('[WeChat] accepted wechat:' + kind + ':' + target),
          'paused intake',
        );
        return () => {
          healthHold = undefined;
          hold.resolve();
        };
      };

      const resumeGroup = await pauseIntake('group', groupTarget, '5');
      wechat.workModes[groupKey] = 'assistant';
      await save();
      resumeGroup();
      await until(() => intakeReceipts.includes('5'.repeat(64)), 'archive under the refreshed group role');
      const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
      const shared = path.join(root, 'state/messages.json');
      const member = path.join(root, 'state/accounts', fixturePluginAccount, 'assistant-group-chat.json');
      assert.equal(read(shared).chats[groupKey], undefined);
      assert.equal(read(member).chats[groupKey][0].message_id, '5'.repeat(64));

      const history = new HistoryStore(root, fixturePluginAccount);
      const reoffers = [
        { oldScope: adminKey, target: admin, digit: '7' },
        { oldScope: key + ':assistant', target: '123', digit: '8' },
      ];
      try {
        for (const { oldScope, target, digit } of reoffers) {
          const id = digit.repeat(64);
          const timestamp = Math.floor(Date.now() / 1000);
          history.append(oldScope, { sender_id: target, message_id: id, timestamp, text: 'already archived' });
          assert.ok(!read(shared).chats['wechat:private:' + target]?.some(row => row.message_id === id));
          ws.send(
            JSON.stringify({
              post_type: 'message',
              message_type: 'private',
              self_id: '999',
              user_id: target,
              message_id: id,
              time: timestamp,
              message: [{ type: 'text', data: { text: 'already archived' } }],
              wechatagent: {
                senderWxid: target,
                readerIntake: { version: 1, rawid: id, token: id, account: fixturePluginAccount, grant: 'legacy' },
              },
            }),
          );
          await until(() => intakeReceipts.includes(id), 'already accepted in another work mode');
          assert.ok(!read(shared).chats['wechat:private:' + target]?.some(row => row.message_id === id));
        }
      } finally {
        history.close();
      }

      const resumeAccount = await pauseIntake('private', accountTarget, '6');
      selectPluginAccount(root, 'e'.repeat(64));
      resumeAccount();
      await until(
        () => logs.includes('[WeChat] account_changed_before_intake ' + accountKey),
        'rechecked reader account',
      );
      assert.equal(read(shared).chats[accountKey], undefined);
      assert.equal(intakeReceipts.includes('6'.repeat(64)), false);
    },
  );
}
