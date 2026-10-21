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
				'Device UUID(s) to watch — locks and/or Open Sensors, comma-separated. List them with `npx n8n-nodes-open-sesame devices`, or read them from the Sesame app under device settings.',
		},
		{
			displayName: 'Tokens JSON',
			name: 'tokensJson',
			type: 'string',
			typeOptions: { password: true, rows: 4 },
			default: '',
			required: true,
			description:
				'Cognito tokens for the SESAME account, as issued by the official passwordless login flow. Mint them with `npx n8n-nodes-open-sesame login <email>` + `verify <code>`, which prints the JSON to paste here. Must include refreshToken, clientId and (if present) deviceKey/deviceGroupKey/devicePassword.',
		},
		{
			displayName: 'Company ID',
			name: 'companyID',
			type: 'string',
			default: 'ch_CandyhouseMobile',
			description:
				'Company ID used by the device-state subscription. Leave as ch_CandyhouseMobile for a personal account.',
		},
	];
}
