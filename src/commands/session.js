import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { Client } from '../client.js';
import { saveConfig, clearConfig, requireConfig } from '../config.js';
import * as out from '../output.js';

const CTRL_C = '\x03';
const BACKSPACE = /[\x7f\x08]/;

// readline echoes what you type; this mutes it for the password prompt only.
function askHidden(question) {
  stdout.write(question);
  let buffer = '';
  return new Promise((resolve) => {
    const cleanup = () => {
      stdin.setRawMode?.(false);
      stdin.pause();
      stdin.removeListener('data', onData);
    };
    const onData = (chunk) => {
      const char = chunk.toString();
      if (char === '\n' || char === '\r') {
        cleanup();
        stdout.write('\n');
        resolve(buffer);
        return;
      }
      if (char === CTRL_C) {
        cleanup();
        stdout.write('\n');
        process.exit(1);
      }
      if (BACKSPACE.test(char)) {
        buffer = buffer.slice(0, -1);
        return;
      }
      buffer += char;
    };
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

export async function loginCommand(url, options) {
  let baseUrl = url;
  // A frequent mistake is pointing at the webapp root rather than the REST root.
  if (!/\/engine-rest\/?$/.test(baseUrl) && !options.noSuffix) {
    baseUrl = baseUrl.replace(/\/+$/, '') + '/engine-rest';
    out.note(`Using ${baseUrl} (pass --no-suffix to use the URL exactly as given).`);
  }

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const username = options.username || (await rl.question('Username: '));
    rl.close();
    const password = options.password || (await askHidden('Password: '));

    const client = new Client({ baseUrl, username, password });
    // /engine answers without auth on some setups, so prove the credential on an
    // endpoint that actually requires it.
    const [engines, count] = await Promise.all([client.engines(), client.processDefinitionCount()]);

    saveConfig({ baseUrl, username, password, engineName: engines[0]?.name ?? 'default' });
    out.line(`Logged in to ${baseUrl} as ${username}.`);
    out.note(`Engine "${engines[0]?.name ?? 'default'}", ${count.count} process definitions deployed.`);
  } catch (err) {
    rl.close();
    if (err.status === 401) {
      throw new Error(`Login failed: the engine rejected these credentials (HTTP 401).`);
    }
    throw new Error(`Login failed: ${err.message}`);
  }
}

export function logoutCommand() {
  clearConfig();
  out.note('Local session cleared.');
}

export async function whoamiCommand() {
  const config = requireConfig();
  const client = new Client(config);
  const [engines, defs, insts, incidents] = await Promise.all([
    client.engines(),
    client.processDefinitionCount(),
    client.get('/process-instance/count'),
    client.get('/incident/count'),
  ]);

  if (out.isJsonMode()) {
    return out.json({
      baseUrl: config.baseUrl,
      username: config.username,
      engines: engines.map((e) => e.name),
      processDefinitions: defs.count,
      runningInstances: insts.count,
      openIncidents: incidents.count,
    });
  }

  out.kv(
    [
      ['user', config.username],
      ['engine', `${config.baseUrl} (${engines.map((e) => e.name).join(', ')})`],
      ['definitions', defs.count],
      ['running', insts.count],
      ['incidents', incidents.count > 0 ? `${incidents.count} open` : '0'],
    ],
    ''
  );
}
