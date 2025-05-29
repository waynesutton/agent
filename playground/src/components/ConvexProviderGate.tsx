import { useState, useEffect, ReactNode, useMemo } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ConvexProvider, ConvexReactClient } from "convex/react";

export const DEPLOYMENT_URL_STORAGE_KEY = "playground_deployment_url";

function isValidHttpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function ConvexProviderGate({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const { url: encodedUrl } = useParams();

  // 1. deploymentUrl always reflects the decoded url param (or null)
  const deploymentUrl = useMemo(() => {
    if (encodedUrl) {
      try {
        return decodeURIComponent(encodedUrl).replace(/\/$/, "");
      } catch (e) {
        console.error("Error decoding url", encodedUrl, e);
        return null;
      }
    }
    return null;
  }, [encodedUrl]);

  // 2. inputValue initially reflects the current url param / localStorage
  const [inputValue, setInputValue] = useState(() => {
    if (deploymentUrl) return deploymentUrl;
    const stored = localStorage.getItem(DEPLOYMENT_URL_STORAGE_KEY);
    return stored ?? "";
  });
  useEffect(() => {
    if (deploymentUrl) setInputValue(deploymentUrl);
  }, [deploymentUrl]);

  const [instanceName, setInstanceName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Optimistically pass through the original deploymentUrl if set.
  const [isValid, setIsValid] = useState(
    !!deploymentUrl && isValidHttpUrl(deploymentUrl)
  );

  // Extracted validation logic for reuse
  const validateDeploymentUrl = async (url: string) => {
    if (!url) {
      setIsValid(false);
      setInstanceName(null);
      setError(null);
      setLoading(false);
      return;
    }
    if (!isValidHttpUrl(url)) {
      setIsValid(false);
      setInstanceName(null);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setInstanceName(null);
    setError(null);
    try {
      const res = await fetch(url + "/instance_name");
      if (!res.ok) throw new Error("Invalid response");
      const name = await res.text();
      setInstanceName(name);
      setError(null);
      setLoading(false);
      setIsValid(true);
      localStorage.setItem(DEPLOYMENT_URL_STORAGE_KEY, url);
    } catch {
      setInstanceName(null);
      setError(
        "Could not validate deployment URL. Please check the URL and try again."
      );
      setLoading(false);
      setIsValid(false);
    }
  };

  // 2. Debounced async validation of deploymentUrl
  useEffect(() => {
    if (!deploymentUrl) return;
    const handler = setTimeout(() => {
      validateDeploymentUrl(deploymentUrl);
    }, 400);
    return () => clearTimeout(handler);
  }, [deploymentUrl]);

  // Polling effect: If deploymentUrl is set but not valid, poll every 3 seconds
  useEffect(() => {
    if (!deploymentUrl || isValid) return;
    // Only poll if we have a URL and it's not valid
    const interval = setInterval(() => {
      validateDeploymentUrl(deploymentUrl);
    }, 3000);
    return () => clearInterval(interval);
  }, [deploymentUrl, isValid]);

  // 4. When user enters a new URL, update the path (which will trigger validation)
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInputValue(e.target.value.trim());
  };
  const handleInputBlur = () => {
    if (inputValue && isValidHttpUrl(inputValue)) {
      navigate(`/play/${encodeURIComponent(inputValue.replace(/\/$/, ""))}`);
    }
  };
  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && inputValue && isValidHttpUrl(inputValue)) {
      navigate(`/play/${encodeURIComponent(inputValue.replace(/\/$/, ""))}`);
    }
  };

  // 3. Only show children if isValid is true
  const convex = useMemo(
    () =>
      isValid && deploymentUrl ? new ConvexReactClient(deploymentUrl) : null,
    [isValid, deploymentUrl]
  );

  if (!deploymentUrl || !isValid || !convex) {
    return (
      <div
        className="fixed inset-0 flex items-center justify-center antialiased"
        style={{ backgroundColor: "#F9F7EE" }}
      >
        <div className="w-full max-w-2xl mx-auto px-4">
          <div
            className="bg-white rounded-xl shadow-sm p-8 border"
            style={{ borderColor: "#E5E7EB" }}
          >
            {/* Header with logo */}
            <div className="flex items-center justify-center mb-8">
              <img
                src={import.meta.env.BASE_URL + "convexlogo.png"}
                alt="Convex"
                className="h-6 w-auto"
              />
            </div>

            <div className="text-center mb-8">
              <h2 className="text-3xl font-bold mb-4 text-gray-900">
                Configure Deployment
              </h2>
              <p className="text-lg text-gray-600 leading-relaxed">
                Enter your Convex deployment URL to connect to the playground
              </p>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-900 mb-2">
                  Deployment URL
                </label>
                <div className="flex gap-3">
                  <input
                    className="flex-1 border rounded-lg px-4 py-3 text-base font-mono bg-white focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-violet-500 transition-colors"
                    style={{ borderColor: "#E5E7EB" }}
                    type="text"
                    value={inputValue}
                    onChange={handleInputChange}
                    onBlur={handleInputBlur}
                    onKeyDown={handleInputKeyDown}
                    placeholder="https://your-deployment.convex.cloud"
                    autoFocus
                  />
                  <button
                    onClick={() => {
                      if (inputValue && isValidHttpUrl(inputValue)) {
                        navigate(
                          `/play/${encodeURIComponent(inputValue.replace(/\/$/, ""))}`
                        );
                      }
                    }}
                    disabled={!inputValue || !isValidHttpUrl(inputValue)}
                    className="px-6 py-3 bg-gray-800 hover:bg-gray-900 disabled:bg-gray-300 disabled:cursor-not-allowed text-white rounded-full shadow-sm focus:ring-2 focus:ring-violet-500 hover:shadow-[0_0_20px_rgba(176,42,91,0.3)] border-2 border-[#B02A5B] disabled:border-gray-300 transition-all duration-200 font-medium"
                  >
                    Connect
                  </button>
                </div>
              </div>

              <div style={{ minHeight: "3rem" }} className="flex items-center">
                {loading ? (
                  <div className="w-full text-center">
                    <div className="inline-flex items-center px-4 py-2 text-sm font-medium text-violet-700 bg-violet-50 rounded-lg border border-violet-200">
                      <div className="animate-spin -ml-1 mr-3 h-4 w-4 border-2 border-violet-500 border-t-transparent rounded-full"></div>
                      Validating deployment...
                    </div>
                  </div>
                ) : instanceName ? (
                  <div className="w-full text-center">
                    <div className="inline-flex items-center px-4 py-2 text-sm font-medium text-green-700 bg-green-50 rounded-lg border border-green-200">
                      <div className="w-2 h-2 bg-green-500 rounded-full mr-2"></div>
                      Connected to: {instanceName}
                    </div>
                  </div>
                ) : error ? (
                  <div className="w-full">
                    <div className="text-red-700 text-sm font-medium bg-red-50 rounded-lg p-3 border border-red-200">
                      {error}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>

            <div className="mt-8 text-center">
              <p className="text-sm text-gray-500">
                Need help? Check out the{" "}
                <a
                  href="https://github.com/get-convex/agent"
                  className="text-violet-600 hover:text-violet-700 font-medium hover:underline"
                >
                  documentation
                </a>
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return <ConvexProvider client={convex}>{children}</ConvexProvider>;
}

export default ConvexProviderGate;
