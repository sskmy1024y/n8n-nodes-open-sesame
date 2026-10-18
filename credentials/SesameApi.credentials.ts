import type { ICredentialType, INodeProperties } from 'n8n-workflow';

export class SesameApi implements ICredentialType {
	name = 'sesameApi';
	displayName = 'Sesame API';
	documentationUrl = 'https://github.com/sskmy1024y/n8n-nodes-open-sesame#credentials';

	properties: INodeProperties[] = [
		{
			displayName: 'Device UUID(s)',
			name: 'deviceUuids',
			type: 'string',
			default: '',
			required: true,
			placeholder: 'XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX',
			description:
				'Sesame device UUID(s) to watch. Multiple UUIDs can be separated by commas. Found in the Sesame app under device settings.',
		},
		{
			displayName: 'Tokens JSON',
			name: 'tokensJson',
			type: 'string',
			typeOptions: { password: true, rows: 4 },
			default: '',
			required: true,
			description:
				'Cognito tokens for the SESAME account, as issued by the official app login flow. Obtain it with `npx sesame-kit login <email>` + `sesame verify <code>` and paste the contents of ~/.config/sesame-kit/tokens.json. Must include refreshToken, clientId and (if present) deviceKey/deviceGroupKey/devicePassword.',
		},
		{
			displayName: 'Company ID',
			name: 'companyID',
			type: 'string',
			default: 'ch_CandyhouseMobile',
			description:
				'Company ID used by the device-state subscription. Personal accounts use ch_CandyhouseMobile (check with `sesame whoami`).',
		},
	];
}
