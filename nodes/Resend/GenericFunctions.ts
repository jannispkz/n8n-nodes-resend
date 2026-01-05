import {
	IExecuteFunctions,
	IHttpRequestMethods,
	ILoadOptionsFunctions,
	INodeProperties,
	INodePropertyOptions,
	NodeOperationError,
} from 'n8n-workflow';

const RESEND_API_BASE = 'https://api.resend.com';

export type ListOptions = {
	after?: string;
	before?: string;
};

/**
 * Factory function to create list options field for any resource.
 * Eliminates duplication of After/Before pagination fields across description files.
 */
export const createListOptions = (
	resource: string,
	resourceLabel: string,
): INodeProperties => ({
	displayName: 'List Options',
	name: `${resource}ListOptions`,
	type: 'collection',
	placeholder: 'Add Option',
	default: {},
	displayOptions: {
		show: {
			resource: [resource],
			operation: ['list'],
		},
	},
	options: [
		{
			displayName: 'After',
			name: 'after',
			type: 'string',
			default: '',
			description: `Return results after this ${resourceLabel} ID`,
		},
		{
			displayName: 'Before',
			name: 'before',
			type: 'string',
			default: '',
			description: `Return results before this ${resourceLabel} ID`,
		},
	],
});

/**
 * Helper to make authenticated requests to the Resend API.
 * Reduces duplication of Authorization headers across all API calls.
 */
export const resendRequest = async <T = unknown>(
	executeFunctions: IExecuteFunctions,
	method: IHttpRequestMethods,
	endpoint: string,
	apiKey: string,
	body?: Record<string, unknown> | Record<string, unknown>[],
	qs?: Record<string, string | number>,
): Promise<T> => {
	return executeFunctions.helpers.httpRequest({
		url: `${RESEND_API_BASE}${endpoint}`,
		method,
		headers: {
			Authorization: `Bearer ${apiKey}`,
		},
		body,
		qs,
		json: true,
	});
};

/**
 * Generic paginated loader for dropdown options.
 * Used by getTemplates, getSegments, getTopics to reduce code duplication.
 */
const paginatedLoadOptions = async (
	loadOptionsFunctions: ILoadOptionsFunctions,
	endpoint: string,
): Promise<INodePropertyOptions[]> => {
	const credentials = await loadOptionsFunctions.getCredentials('resendApi');
	const apiKey = credentials.apiKey as string;
	const returnData: INodePropertyOptions[] = [];
	const limit = 100;
	let after: string | undefined;
	let hasMore = true;
	let pageCount = 0;
	const maxPages = 10;

	while (hasMore) {
		const qs: Record<string, string | number> = { limit };
		if (after) {
			qs.after = after;
		}

		const response = await loadOptionsFunctions.helpers.httpRequest({
			url: `${RESEND_API_BASE}${endpoint}`,
			method: 'GET',
			headers: {
				Authorization: `Bearer ${apiKey}`,
			},
			qs,
			json: true,
		});

		const items = response?.data ?? [];
		for (const item of items) {
			if (!item?.id) {
				continue;
			}
			const name = item.name ? `${item.name} (${item.id})` : item.id;
			returnData.push({
				name,
				value: item.id,
			});
		}

		hasMore = Boolean(response?.has_more);
		after = items.length ? items[items.length - 1].id : undefined;
		pageCount += 1;
		if (!after || pageCount >= maxPages) {
			break;
		}
	}

	return returnData;
};

export const normalizeEmailList = (value: string | string[] | undefined) => {
	if (Array.isArray(value)) {
		return value
			.map((email) => String(email).trim())
			.filter((email) => email);
	}
	if (typeof value === 'string') {
		return value
			.split(',')
			.map((email) => email.trim())
			.filter((email) => email);
	}
	return [];
};

export const parseTemplateVariables = (
	executeFunctions: IExecuteFunctions,
	variablesInput: { variables?: Array<{ key: string; type: string; fallbackValue?: unknown }> } | undefined,
	fallbackKey: 'fallbackValue' | 'fallback_value',
	itemIndex: number,
) => {
	if (!variablesInput?.variables?.length) {
		return undefined;
	}

	return variablesInput.variables.map((variable) => {
		const variableEntry: Record<string, unknown> = {
			key: variable.key,
			type: variable.type,
		};

		const fallbackValue = variable.fallbackValue;
		if (fallbackValue !== undefined && fallbackValue !== '') {
			let parsedFallback: string | number = fallbackValue as string;
			if (variable.type === 'number') {
				const numericFallback = typeof fallbackValue === 'number' ? fallbackValue : Number(fallbackValue);
				if (Number.isNaN(numericFallback)) {
					throw new NodeOperationError(
						executeFunctions.getNode(),
						`Variable "${variable.key}" fallback value must be a number`,
						{ itemIndex },
					);
				}
				parsedFallback = numericFallback;
			}
			variableEntry[fallbackKey] = parsedFallback;
		}

		return variableEntry;
	});
};

export const buildTemplateSendVariables = (
	variablesInput: { variables?: Array<{ key: string; value?: unknown }> } | undefined,
) => {
	if (!variablesInput?.variables?.length) {
		return undefined;
	}
	const variables: Record<string, unknown> = {};
	for (const variable of variablesInput.variables) {
		if (!variable.key) {
			continue;
		}
		variables[variable.key] = variable.value ?? '';
	}

	return Object.keys(variables).length ? variables : undefined;
};

export const requestList = async (
	executeFunctions: IExecuteFunctions,
	url: string,
	listOptions: ListOptions,
	apiKey: string,
	itemIndex: number,
	returnAll: boolean,
	limit?: number,
) => {
	if (listOptions.after && listOptions.before) {
		throw new NodeOperationError(
			executeFunctions.getNode(),
			'You can only use either "After" or "Before", not both.',
			{ itemIndex },
		);
	}

	const shouldReturnAll = returnAll === true;
	const qs: Record<string, string | number> = {};
	const pageSize = shouldReturnAll ? 100 : (limit ?? 50);

	if (pageSize !== undefined) {
		qs.limit = pageSize;
	}
	if (listOptions.after) {
		qs.after = listOptions.after;
	}
	if (listOptions.before) {
		qs.before = listOptions.before;
	}

	const requestPage = () =>
		executeFunctions.helpers.httpRequest({
			url,
			method: 'GET',
			headers: {
				Authorization: `Bearer ${apiKey}`,
			},
			qs,
			json: true,
		});

	if (!shouldReturnAll) {
		const singleResponse = await requestPage();
		if (
			typeof limit === 'number' &&
			limit > 0 &&
			Array.isArray((singleResponse as { data?: unknown[] }).data)
		) {
			const responseData = (singleResponse as { data?: unknown[] }).data ?? [];
			if (responseData.length > limit) {
				(singleResponse as { data: unknown[] }).data = responseData.slice(0, limit);
			}
		}
		return singleResponse;
	}

	const allItems: unknown[] = [];
	let lastResponse: unknown;
	let hasMore = true;
	let pageCount = 0;
	const maxPages = 100;
	let paginationMode: 'after' | 'before' | undefined = listOptions.before ? 'before' : undefined;

	while (hasMore) {
		lastResponse = await requestPage();
		const responseData = Array.isArray((lastResponse as { data?: unknown[] }).data)
			? ((lastResponse as { data?: unknown[] }).data as unknown[])
			: [];
		allItems.push(...responseData);

		hasMore = Boolean((lastResponse as { has_more?: boolean }).has_more);
		pageCount += 1;
		if (!hasMore || responseData.length === 0 || pageCount >= maxPages) {
			break;
		}

		const lastItem = responseData[responseData.length - 1] as { id?: string } | undefined;
		if (!lastItem?.id) {
			break;
		}

		if (paginationMode === 'before') {
			qs.before = lastItem.id;
			delete qs.after;
		} else {
			qs.after = lastItem.id;
			delete qs.before;
			paginationMode = 'after';
		}
	}

	if (lastResponse && Array.isArray((lastResponse as { data?: unknown[] }).data)) {
		(lastResponse as { data: unknown[] }).data = allItems;
		(lastResponse as { has_more?: boolean }).has_more = false;
		return lastResponse;
	}

	return { object: 'list', data: allItems, has_more: false };
};

export async function getTemplateVariables(
	this: ILoadOptionsFunctions,
): Promise<INodePropertyOptions[]> {
	const getStringValue = (value: unknown) =>
		typeof value === 'string' && value.trim() ? value : undefined;
	const safeGet = (getter: () => unknown) => {
		try {
			return getter();
		} catch {
			return undefined;
		}
	};
	const getParameterValue = (name: string) => {
		const currentParameters = this.getCurrentNodeParameters();
		const fromCurrentParameters = getStringValue(currentParameters?.[name]);
		if (fromCurrentParameters) {
			return fromCurrentParameters;
		}

		const fromCurrentNodeParameter = getStringValue(
			safeGet(() => this.getCurrentNodeParameter(name)),
		);
		if (fromCurrentNodeParameter) {
			return fromCurrentNodeParameter;
		}

		const fromNodeParameter = getStringValue(safeGet(() => this.getNodeParameter(name, '')));
		if (fromNodeParameter) {
			return fromNodeParameter;
		}

		return undefined;
	};

	const templateId = getParameterValue('emailTemplateId') ?? getParameterValue('templateId');
	if (!templateId) {
		return [];
	}
	const normalizedTemplateId = templateId.trim();
	if (normalizedTemplateId.startsWith('={{') || normalizedTemplateId.includes('{{')) {
		return [];
	}

	const credentials = await this.getCredentials('resendApi');
	const apiKey = credentials.apiKey as string;

	const response = await this.helpers.httpRequest({
		url: `https://api.resend.com/templates/${encodeURIComponent(templateId)}`,
		method: 'GET',
		headers: {
			Authorization: `Bearer ${apiKey}`,
		},
		json: true,
	});

	const variables = response?.variables ?? [];

	return variables
		.filter((variable: { key?: string }) => variable?.key)
		.map((variable: { key: string; type?: string }) => {
			const typeLabel = variable.type ? ` (${variable.type})` : '';
			return {
				name: `${variable.key}${typeLabel}`,
				value: variable.key,
			};
		});
}

export async function getTemplates(
	this: ILoadOptionsFunctions,
): Promise<INodePropertyOptions[]> {
	return paginatedLoadOptions(this, '/templates');
}

export async function getSegments(
	this: ILoadOptionsFunctions,
): Promise<INodePropertyOptions[]> {
	return paginatedLoadOptions(this, '/segments');
}

export async function getTopics(
	this: ILoadOptionsFunctions,
): Promise<INodePropertyOptions[]> {
	return paginatedLoadOptions(this, '/topics');
}
