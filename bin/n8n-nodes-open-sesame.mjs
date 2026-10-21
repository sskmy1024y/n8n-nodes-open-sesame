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
 */
import { createRequire } from 'node:module';

const CONSUMER_COMPANY_ID = 'ch_CandyhouseMobile';

const USAGE = `n8n-nodes-open-sesame — mint SESAME tokens for the n8n credential

Usage:
  npx n8n-nodes-open-sesame login <email>     Email yourself a verification code
  npx n8n-nodes-open-sesame verify <code>     Answer the code; prints the Tokens JSON
  npx n8n-nodes-open-sesame tokens            Re-print the stored Tokens JSON
  npx n8n-nodes-open-sesame devices           List device UUIDs and models
  npx n8n-nodes-open-sesame logout            Revoke this refresh token and delete it

Options:
  --config-dir <dir>   Where tokens are stored (default: ~/.config/sesame-kit)
  --company <id>       Company ID for 'devices' (default: ${CONSUMER_COMPANY_ID})
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
