import type {
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class SesameApi implements ICredentialType {
	name = 'sesameApi';
	displayName = 'Sesame API';
	documentationUrl = 'https://docs.candyhouse.co/';

	properties: INodeProperties[] = [
		{
			displayName: 'Device UUID(s)',
			name: 'deviceUuids',
			type: 'string',
			default: '',
			required: true,
			placeholder: 'XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX',
			description:
				'Sesame device UUID(s). Multiple UUIDs can be separated by commas. Found in the Sesame app under device settings.',
		},
	];
}
