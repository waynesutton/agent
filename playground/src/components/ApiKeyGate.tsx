import { useState, useEffect, ReactNode } from "react";
import { useConvex } from "convex/react";
import type { PlaygroundAPI } from "../definePlaygroundAPI";
import { anyApi } from "convex/server";
import { Button } from "./ui/button";
import { useParams } from "react-router-dom";

const API_KEY_STORAGE_KEY = "playground_api_key";
const API_PATH_STORAGE_KEY = "playground_api_path";
const CLI_COMMAND = `npx convex run --component agent apiKeys:issue '{name: "..."}'`;
const PLAYGROUND_CODE = `
import { definePlaygroundAPI } from "@convex-dev/agent/playground";
import { components } from "./_generated/api";
import { weatherAgent, fashionAgent } from "./example";

export const {
  isApiKeyValid,
  listAgents,
  listUsers,
  listThreads,
  listMessages,
  createThread,
  generateText,
  fetchPromptContext,
} = definePlaygroundAPI(components.agent, { agents: [weatherAgent, fashionAgent] });
`;

function getApi(apiPath: string) {
  return apiPath
    .trim()
    .split("/")
    .reduce((acc, part) => acc[part], anyApi) as unknown as PlaygroundAPI;
}

function ApiKeyGate({
  children,
}: {
  children: (apiKey: string, api: PlaygroundAPI) => ReactNode;
}) {
  const { url: encodedUrl } = useParams();
  const [apiKey, setApiKey] = useState<string>(() => {
    const storedKey = sessionStorage.getItem(
      `${API_KEY_STORAGE_KEY}-${encodedUrl}`
    );
    if (storedKey) {
      return storedKey;
    }
    return "";
  });
  const [apiKeyValid, setApiKeyValid] = useState<boolean>(!!apiKey);
  const [apiKeyInput, setApiKeyInput] = useState(apiKey || "");
  const [apiPath, setApiPath] = useState<string>(() => {
    const storedPath = sessionStorage.getItem(
      `${API_PATH_STORAGE_KEY}-${encodedUrl}`
    );
    if (storedPath) {
      return storedPath;
    }
    return "playground";
  });
  const [apiPathInput, setApiPathInput] = useState(apiPath);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const convex = useConvex();
  const [isConnected, setIsConnected] = useState<boolean | null>(null);

  // Validate on every keystroke
  useEffect(() => {
    if (!apiPathInput) return;
    const nextApi = getApi(apiPathInput);
    convex
      .query(nextApi.isApiKeyValid, { apiKey: apiKeyInput })
      .then((isValid) => {
        sessionStorage.setItem(
          `${API_PATH_STORAGE_KEY}-${encodedUrl}`,
          apiPathInput
        );
        setApiPath(apiPathInput);
        if (isValid) {
          setApiKeyValid(true);
          setError(null);
          // Simulate form submission for password managers
        } else {
          setApiKeyValid(false);
          setError("Invalid API key for this playground path.");
        }
        setIsConnected(true);
      })
      .catch((err) => {
        if (!convex.connectionState().isWebSocketConnected) {
          setIsConnected(false);
        } else {
          setApiPath("");
        }
        setError(
          "Invalid playground path (could not find isApiKeyValid).\nPlease check the path and try again.\n" +
            "e.g. if you exported the API in convex/foo/playground.ts, it would be foo/playground.\n" +
            "The code there should be:\n" +
            PLAYGROUND_CODE
        );
      });
  }, [apiKeyInput, apiPathInput, convex, encodedUrl]);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (apiKeyValid) {
      sessionStorage.setItem(
        `${API_KEY_STORAGE_KEY}-${encodedUrl}`,
        apiKeyInput
      );
      setApiKey(apiKeyInput);
    }
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(CLI_COMMAND);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  if (!apiKey || !apiPath || !apiKeyValid) {
    return (
      <div
        className="min-h-screen antialiased"
        style={{ backgroundColor: "#F9F7EE" }}
      >
        {/* Header */}
        <header style={{ backgroundColor: "#F9F7EE" }}>
          <div className="container mx-auto px-2 py-4">
            <div className="flex items-center justify-between">
              {/* Left logo */}
              <div className="flex items-center">
                <img
                  src={import.meta.env.BASE_URL + "convexlogo.png"}
                  alt="Convex"
                  className="h-3.5 w-auto"
                />
              </div>

              {/* Right nav */}
              <div className="flex items-center">
                <nav className="hidden md:flex space-x-4">
                  <a
                    href="https://www.convex.dev/components/agent"
                    className="neutral-800 hover:text-gray-900"
                  >
                    Agent Component
                  </a>
                  <a
                    href="https://github.com/get-convex/agent"
                    className="neutral-800 hover:text-gray-900"
                  >
                    Docs
                  </a>
                </nav>
              </div>
            </div>
          </div>
        </header>

        {/* Main Content */}
        <div className="container mx-auto px-4 py-8">
          <div className="max-w-4xl mx-auto">
            <form
              onSubmit={handleSubmit}
              className="bg-white rounded-xl shadow-sm p-8 border"
              style={{ borderColor: "#E5E7EB" }}
            >
              <div className="text-center mb-8">
                <h2 className="text-4xl font-bold mb-4 text-gray-900">
                  Configure the playground
                </h2>
                <p className="text-lg text-gray-600 leading-relaxed">
                  Set up your API configuration to start using the Agent
                  Playground
                </p>
                {isConnected === false && (
                  <div className="text-red-700 text-sm font-medium bg-red-50 rounded-lg p-3 border border-red-200 mt-4">
                    Backend is not connected. Please check your internet
                    connection, or the Convex deployment URL in the environment
                    variables / sessionStorage.
                  </div>
                )}
              </div>

              <div className="space-y-8">
                {/* API Path Section */}
                <div>
                  <h3 className="text-xl font-semibold mb-4 text-gray-900 flex items-center gap-2">
                    API Path {apiPath ? "✅" : "❌"}
                  </h3>
                  <div className="space-y-2">
                    <label className="block text-sm font-medium text-gray-900">
                      Playground API Path
                    </label>
                    <input
                      className="w-full border rounded-lg px-4 py-3 text-base font-mono bg-white focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-violet-500 transition-colors"
                      style={{ borderColor: "#E5E7EB" }}
                      type="text"
                      autoComplete="username"
                      id="agent-playground-api-path"
                      value={apiPathInput}
                      onChange={(e) => setApiPathInput(e.target.value.trim())}
                      placeholder="playground"
                      autoFocus
                    />
                    <p className="text-sm text-gray-600">
                      Where you exported the playground api with
                      definePlaygroundAPI. Usually{" "}
                      <code className="bg-gray-100 px-2 py-1 rounded text-sm">
                        playground
                      </code>
                      .
                    </p>
                  </div>
                </div>

                {/* API Key Section */}
                <div>
                  <h3 className="text-xl font-semibold mb-4 text-gray-900 flex items-center gap-2">
                    API Key {apiKeyValid ? "✅" : "❌"}
                  </h3>
                  <div className="space-y-4">
                    <p className="text-gray-600 leading-relaxed">
                      To use the Playground, you need an API key. After setting
                      up the agent in your app, run this command in your project
                      directory (CLI or Convex dashboard):
                    </p>

                    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                      <div className="bg-gray-50 px-4 py-3 border-b border-gray-200">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center space-x-2">
                            <div className="w-3 h-3 bg-red-400 rounded-full"></div>
                            <div className="w-3 h-3 bg-yellow-400 rounded-full"></div>
                            <div className="w-3 h-3 bg-green-400 rounded-full"></div>
                          </div>
                          <div className="text-sm text-gray-500">Terminal</div>
                          <button
                            type="button"
                            onClick={handleCopy}
                            className="flex items-center gap-1 px-2 py-1 bg-gray-800 hover:bg-gray-700 text-white rounded text-xs transition-colors"
                            tabIndex={-1}
                            aria-label="Copy command"
                          >
                            {copied ? (
                              <span>Copied!</span>
                            ) : (
                              <>
                                <svg
                                  width="12"
                                  height="12"
                                  fill="none"
                                  viewBox="0 0 24 24"
                                >
                                  <rect
                                    x="9"
                                    y="9"
                                    width="13"
                                    height="13"
                                    rx="2"
                                    fill="#fff"
                                    fillOpacity="0.1"
                                    stroke="#fff"
                                    strokeWidth="2"
                                  />
                                  <rect
                                    x="3"
                                    y="3"
                                    width="13"
                                    height="13"
                                    rx="2"
                                    fill="#fff"
                                    fillOpacity="0.2"
                                    stroke="#fff"
                                    strokeWidth="2"
                                  />
                                </svg>
                                Copy
                              </>
                            )}
                          </button>
                        </div>
                      </div>
                      <div className="p-4">
                        <pre className="text-sm text-gray-800 font-mono">
                          <code>{CLI_COMMAND}</code>
                        </pre>
                      </div>
                    </div>

                    <p className="text-gray-600">
                      Paste the resulting API key below.
                    </p>

                    <input
                      className="w-full border rounded-lg px-4 py-3 text-base font-mono bg-white focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-violet-500 transition-colors"
                      style={{ borderColor: "#E5E7EB" }}
                      type="password"
                      autoComplete="current-password"
                      name="api-key"
                      id="agent-playground-api-key"
                      value={apiKeyInput}
                      onChange={(e) =>
                        setApiKeyInput(
                          e.target.value
                            .trim()
                            .replace(/^['"]|['"]$/g, "")
                            .trim()
                        )
                      }
                      placeholder="API Key"
                    />

                    {error && (
                      <div className="bg-white rounded-xl border border-red-200 overflow-hidden">
                        <div className="bg-red-50 px-4 py-3 border-b border-red-200">
                          <div className="text-sm text-red-700 font-medium">
                            Error
                          </div>
                        </div>
                        <div className="p-4">
                          <pre className="text-sm text-red-800 font-mono whitespace-pre-wrap">
                            <code>{error}</code>
                          </pre>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex justify-center pt-4">
                  <button
                    type="submit"
                    disabled={!apiPath || !apiKeyValid}
                    className="px-8 py-3 bg-gray-800 hover:bg-gray-900 disabled:bg-gray-300 disabled:cursor-not-allowed text-white rounded-full shadow-sm focus:ring-2 focus:ring-violet-500 hover:shadow-[0_0_20px_rgba(176,42,91,0.3)] border-2 border-[#B02A5B] disabled:border-gray-300 transition-all duration-200 font-medium"
                  >
                    Submit
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>

        {/* Footer */}
        <footer className="bg-black mt-20">
          <div className="container mx-auto px-4 py-8">
            <div className="flex flex-col md:flex-row items-center justify-between">
              <div className="text-white text-sm">
                <a
                  href="https://convex.dev"
                  className="text-white hover:text-orange-500 font-medium"
                >
                  Convex
                </a>{" "}
                Agent Playground
              </div>
              <div className="flex items-center space-x-6 mt-4 md:mt-0">
                <a
                  href="https://github.com/get-convex/agent#installation"
                  className="text-white hover:text-gray-300 text-sm"
                >
                  Docs
                </a>
                <a
                  href="https://convex.dev/components/agent"
                  className="text-white hover:text-gray-300 text-sm"
                >
                  Components
                </a>
              </div>
            </div>
          </div>
        </footer>
      </div>
    );
  }

  // Construct the API object using the playground path
  const api: PlaygroundAPI = apiPath
    .trim()
    .split("/")
    .reduce((acc, part) => acc[part], anyApi) as unknown as PlaygroundAPI;
  // Valid
  return children(apiKey, api);
}

export default ApiKeyGate;
