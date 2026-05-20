// SPDX-License-Identifier: Apache-2.0

/**
 * Generic API client with timeout, retry, and error handling
 * Designed for policy integrations with external ML/moderation APIs
 */

export interface APIClientConfig {
  timeout?: number; // Timeout in milliseconds (default: 3000)
  retries?: number; // Number of retries (default: 0)
  retryDelay?: number; // Delay between retries in ms (default: 1000)
  headers?: Record<string, string>;
}

export interface APIResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  statusCode?: number;
  timedOut?: boolean;
}

export class APIClient {
  private defaultConfig: APIClientConfig;

  constructor(defaultConfig: APIClientConfig = {}) {
    this.defaultConfig = {
      timeout: 3000,
      retries: 0,
      retryDelay: 1000,
      ...defaultConfig,
    };
  }

  /**
   * Make a POST request with timeout and retry support
   */
  async post<T>(
    url: string,
    body: unknown,
    config: APIClientConfig = {},
  ): Promise<APIResponse<T>> {
    const mergedConfig = { ...this.defaultConfig, ...config };
    let lastError: string | undefined;

    // Attempt request with retries
    for (let attempt = 0; attempt <= (mergedConfig.retries ?? 0); attempt++) {
      if (attempt > 0) {
        // Wait before retry
        await new Promise((resolve) =>
          setTimeout(resolve, mergedConfig.retryDelay),
        );
      }

      try {
        const result = await this.makeRequest<T>(url, body, mergedConfig);
        if (result.success) {
          return result;
        }
        lastError = result.error;
      } catch (error) {
        lastError = error instanceof Error ? error.message : 'Unknown error';
      }
    }

    return {
      success: false,
      error: lastError ?? 'Request failed after retries',
    };
  }

  /**
   * Make a GET request with timeout support
   */
  async get<T>(
    url: string,
    config: APIClientConfig = {},
  ): Promise<APIResponse<T>> {
    const mergedConfig = { ...this.defaultConfig, ...config };

    try {
      return await this.makeGetRequest<T>(url, mergedConfig);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Internal method to make POST request with timeout
   */
  private async makeRequest<T>(
    url: string,
    body: unknown,
    config: APIClientConfig,
  ): Promise<APIResponse<T>> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.timeout);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...config.headers,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        return {
          success: false,
          error: `HTTP ${response.status}: ${response.statusText}`,
          statusCode: response.status,
        };
      }

      const data = await response.json();
      return {
        success: true,
        data: data as T,
        statusCode: response.status,
      };
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error && error.name === 'AbortError') {
        return {
          success: false,
          error: 'Request timed out',
          timedOut: true,
        };
      }

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Request failed',
      };
    }
  }

  /**
   * Internal method to make GET request with timeout
   */
  private async makeGetRequest<T>(
    url: string,
    config: APIClientConfig,
  ): Promise<APIResponse<T>> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.timeout);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: config.headers,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        return {
          success: false,
          error: `HTTP ${response.status}: ${response.statusText}`,
          statusCode: response.status,
        };
      }

      const data = await response.json();
      return {
        success: true,
        data: data as T,
        statusCode: response.status,
      };
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error && error.name === 'AbortError') {
        return {
          success: false,
          error: 'Request timed out',
          timedOut: true,
        };
      }

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Request failed',
      };
    }
  }
}

/**
 * Utility to safely get API key from environment
 * @throws Error if key is not found
 */
export function requireAPIKey(envVar: string): string {
  const key = process.env[envVar];
  if (!key) {
    throw new Error(`Missing required environment variable: ${envVar}`);
  }
  return key;
}

/**
 * Utility to get optional API key from environment
 */
export function getAPIKey(envVar: string): string | undefined {
  return process.env[envVar];
}
