import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
    output: "standalone",
    outputFileTracingRoot: path.join(__dirname),
    /* config options here */
    allowedDevOrigins: ["localhost",
        "100.70.24.30", "msi-eulysis", "100.119.3.44", "msi-jake"
    ],
};

export default nextConfig;
