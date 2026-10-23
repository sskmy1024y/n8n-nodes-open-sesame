#!/usr/bin/env node
/**
 * Mints the SESAME account tokens that the Sesame Trigger credential needs.
 *
 * This is a thin wrapper over `@sesame-kit/core` — the same package the node itself runs on — so
 * setting the node up needs nothing beyond the package you already installed. The login is the
 * official passwordless flow: a code is emailed, you answer the challenge with it.
 *
 * Tokens are written to the config dir (shared with the `sesame-kit` CLI, if you also use it) and
 * printed so they can be pasted into n8n's credential form.
 *
 * `setup` walks the whole thing interactively (email -> code -> device pick -> credential values);
 * the individual commands stay available for scripted/non-interactive use.
 */
import { createRequire } from 'node:module';
import * as readline from 'node:readline/promises';

const CONSUMER_COMPANY_ID = 'ch_CandyhouseMobile';

const USAGE = `n8n-nodes-open-sesame — mint SESAME tokens for the n8n credential

Usage:
  npx n8n-nodes-open-sesame setup [email]     Guided setup: login, verify, pick devices
  npx n8n-nodes-open-sesame login <email>     Email yourself a verification code
  npx n8n-nodes-open-sesame verify <code>     Answer the code; prints the Tokens JSON
  npx n8n-nodes-open-sesame tokens            Re-print the stored Tokens JSON
  npx n8n-nodes-open-sesame devices           List device UUIDs and models
  npx n8n-nodes-open-sesame logout            Revoke this refresh token and delete it

Options:
  --config-dir <dir>   Where tokens are stored (default: ~/.config/sesame-kit)
  --company <id>       Company ID for 'devices'/'setup' (default: ${CONSUMER_COMPANY_ID})

Start with 'setup' if you are configuring the credential for the first time.
`;

function parseArgs(argv) {
	const positional = [];
	const flags = {};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === '--config-dir' || arg === '--company') {
			flags[arg.replace(/^--/, '')] = argv[i + 1];
			i += 1;
		} else if (arg === '-h' || arg === '--help') {
			flags.help = true;
		} else {
			positional.push(arg);
		}
	}
	return { positional, flags };
}

function fail(message) {
	console.error(`error: ${message}`);
	process.exit(1);
}

/** Resolves @sesame-kit/core relative to this package, not the caller's cwd. */
async function loadCore(subpath) {
	const require = createRequire(import.meta.url);
	try {
		return await import(require.resolve(`@sesame-kit/core/${subpath}`));
	} catch (error) {
		fail(
			`cannot load @sesame-kit/core/${subpath} (${error.message}). ` +
				'Run this from an installation that has the package\'s dependencies, e.g. ' +
				'`npm install n8n-nodes-open-sesame`.',
		);
	}
}

async function openStore(configDir) {
	const { FileTokenStore } = await loadCore('tokens');
	return FileTokenStore.fromConfigDir(configDir);
}

/** The credential field wants exactly this: the stored token object, as JSON. */
function printTokens(tokens) {
	if (!tokens?.refreshToken) {
		fail('no tokens stored yet. Run `login` then `verify` first.');
	}
	console.log(JSON.stringify(tokens, null, 2));
	console.error(
		'\n^ paste the JSON above into the credential\'s "Tokens JSON" field.\n' +
			'These tokens grant full control of your lock — treat them like a password.',
	);
}

/**
 * Interactive prompts.
 *
 * Everything conversational goes to stderr so stdout stays a clean, pipeable transcript of the
 * values you actually need (`setup > credential.txt` keeps working). readline echoes typed input
 * on the terminal itself, so the prompts are not duplicated there.
 */
function openPrompt() {
	if (!process.stdin.isTTY) {
		fail(
			'setup needs an interactive terminal. In a script, use `login <email>` then ' +
				'`verify <code>` and `devices` instead.',
		);
	}
	const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
	// Without this, Ctrl-C during a question leaves the pending promise forever unresolved.
	rl.on('SIGINT', () => cancel(rl));
	return rl;
}

/** Abandons the flow on Ctrl-C / Ctrl-D. 130 is the conventional "interrupted" status. */
function cancel(rl) {
	rl.close();
	// Deliberately not "nothing was changed": cancelling after the code was accepted leaves the
	// minted tokens on disk, and re-running picks up from there.
	console.error('\nCancelled. Re-run `setup` to continue — tokens already minted are kept.');
	process.exit(130);
}

/**
 * One prompt. Ctrl-D rejects the readline promise with an AbortError; left unhandled that
 * surfaces as a stack trace mid-setup, so treat it as the cancellation the user meant.
 */
async function question(rl, text) {
	try {
		return await rl.question(text);
	} catch (error) {
		if (error?.code === 'ABORT_ERR') cancel(rl);
		throw error;
	}
}

/** Asks until the answer passes `validate`, which returns the cleaned value or throws. */
async function ask(rl, text, validate = (v) => v.trim()) {
	for (;;) {
		const answer = await question(rl, text);
		try {
			return validate(answer);
		} catch (error) {
			console.error(`  ${error.message}`);
		}
	}
}

async function askYesNo(rl, text, fallback) {
	const answer = (await question(rl, text)).trim().toLowerCase();
	if (answer === '') return fallback;
	return answer === 'y' || answer === 'yes';
}

/**
 * Parses a device selection: empty or "all" means every device, otherwise 1-based indices.
 * Accepts commas and/or whitespace ("1,3" and "1 3" both work).
 */
function parseDeviceSelection(answer, devices) {
	const trimmed = answer.trim().toLowerCase();
	if (trimmed === '' || trimmed === 'all') return devices;

	const picked = trimmed
		.split(/[\s,]+/)
		.filter(Boolean)
		.map((token) => {
			const index = Number(token);
			if (!Number.isInteger(index) || index < 1 || index > devices.length) {
				throw new Error(`"${token}" is not a number between 1 and ${devices.length}.`);
			}
			return devices[index - 1];
		});
	// Same device listed twice would duplicate it in the credential field.
	return [...new Set(picked)];
}

function describeDevice(device) {
	const name = device.deviceName ? ` — ${device.deviceName}` : '';
	return `${device.deviceUUID}  ${device.deviceModel ?? '?'}${name}`;
}

async function runSetup(rl, { configDir, companyID, email }) {
	const store = await openStore(configDir);
	const { loginInitiate, loginVerify } = await loadCore('auth');

	console.error('SESAME account setup for the n8n credential.\n');

	// Step 1 — sign in, unless usable tokens are already stored.
	let tokens = store.load();
	const reuse =
		tokens?.refreshToken &&
		(await askYesNo(
			rl,
			`Tokens for ${tokens.username ?? 'an account'} are already stored. Reuse them? [Y/n] `,
			true,
		));

	if (!reuse) {
		const address =
			email ??
			(await ask(rl, 'SESAME account email: ', (value) => {
				const cleaned = value.trim();
				// Deliberately loose: the real check is whether the code actually arrives.
				if (!cleaned.includes('@')) throw new Error('That does not look like an email address.');
				return cleaned;
			}));

		await loginInitiate(store, address);
		console.error(`\nA verification code was emailed to ${address}.`);

		// Cognito allows a few attempts on the same challenge before the session dies; a typo
		// should not mean restarting the whole flow.
		for (let attempt = 1; ; attempt += 1) {
			const code = await ask(rl, 'Verification code: ', (value) => {
				const cleaned = value.trim();
				if (!cleaned) throw new Error('Enter the code from the email.');
				return cleaned;
			});
			try {
				tokens = await loginVerify(store, code);
				break;
			} catch (error) {
				if (attempt >= 3) {
					fail(
						`${error.message}\nToo many attempts. Re-run setup to request a fresh code.`,
					);
				}
				console.error(`  Rejected: ${error.message} — try again.`);
			}
		}
		console.error('Signed in.\n');
	} else {
		console.error('');
	}

	// Step 2 — pick the devices to watch.
	const { SesameHub3 } = await loadCore('client');
	let selected = [];
	await SesameHub3.use({ tokenStore: store, config: { companyID } }, async (hub) => {
		const devices = (await hub.listDevices()).filter((device) => device?.deviceUUID);
		if (devices.length === 0) {
			console.error('No devices on this account — add one in the SESAME app, then re-run setup.');
			return;
		}

		console.error('Devices on this account:');
		devices.forEach((device, index) => {
			console.error(`  ${index + 1}) ${describeDevice(device)}`);
		});

		selected = await ask(
			rl,
			'\nWatch which devices? (numbers, or Enter for all) ',
			(value) => parseDeviceSelection(value, devices),
		);
	});

	// Step 3 — hand over the three credential fields.
	const stored = store.load();
	console.error('\n--- Paste these into n8n: Credentials > New > Sesame API ---\n');

	console.error('Device UUID(s):');
	console.log(selected.map((device) => device.deviceUUID).join(','));
	console.error('\nCompany ID:');
	console.log(companyID);
	console.error('\nTokens JSON:');
	console.log(JSON.stringify(stored, null, 2));

	console.error(
		'\nThese tokens grant full control of your lock — treat them like a password.\n' +
			`They are also saved locally; re-print them any time with ` +
			'`npx n8n-nodes-open-sesame tokens`.',
	);
}

async function main() {
	const { positional, flags } = parseArgs(process.argv.slice(2));
	const [command, value] = positional;

	if (flags.help || !command) {
		console.log(USAGE);
		// `--help` is a successful request for help; a bare invocation is a usage error.
		process.exit(flags.help ? 0 : 1);
	}

	const configDir = flags['config-dir'] ?? process.env.SESAME_CONFIG_DIR;

	switch (command) {
		case 'setup': {
			const rl = openPrompt();
			try {
				await runSetup(rl, {
					configDir,
					companyID: flags.company ?? CONSUMER_COMPANY_ID,
					email: value,
				});
			} finally {
				rl.close();
			}
			break;
		}
		case 'login': {
			if (!value) fail('login needs an email address');
			const store = await openStore(configDir);
			const { loginInitiate } = await loadCore('auth');
			await loginInitiate(store, value);
			console.error(`A verification code was emailed to ${value}.`);
			console.error('Next: npx n8n-nodes-open-sesame verify <code>');
			break;
		}
		case 'verify': {
			if (!value) fail('verify needs the code from the email');
			const store = await openStore(configDir);
			const { loginVerify } = await loadCore('auth');
			printTokens(await loginVerify(store, value));
			break;
		}
		case 'tokens': {
			const store = await openStore(configDir);
			printTokens(store.load());
			break;
		}
		case 'devices': {
			const store = await openStore(configDir);
			if (!store.load()?.refreshToken) fail('not logged in. Run `login` then `verify` first.');
			const { SesameHub3 } = await loadCore('client');
			const companyID = flags.company ?? CONSUMER_COMPANY_ID;
			await SesameHub3.use({ tokenStore: store, config: { companyID } }, async (hub) => {
				const devices = await hub.listDevices();
				if (devices.length === 0) {
					console.error('No devices on this account.');
					return;
				}
				for (const device of devices) {
					const name = device.deviceName ? ` — ${device.deviceName}` : '';
					console.log(`${device.deviceUUID}  ${device.deviceModel ?? '?'}${name}`);
				}
				console.error(
					'\n^ put the UUID(s) you want to watch in the credential\'s "Device UUID(s)" field.',
				);
			});
			break;
		}
		case 'logout': {
			const store = await openStore(configDir);
			const { logout } = await loadCore('auth');
			const result = await logout(store);
			console.error(
				`Logged out (device forgotten: ${result.forgotDevice}, token revoked: ${result.revokedToken}). ` +
					'Credentials in n8n using these tokens will stop working.',
			);
			break;
		}
		default:
			fail(`unknown command "${command}". Run with --help for usage.`);
	}
}

main().catch((error) => fail(error?.message ?? String(error)));
