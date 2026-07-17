/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingExcludes: { '*': ['./local/**'] },
};

export default nextConfig;
