// Learn more https://docs.expo.dev/router/reference/static-rendering/#root-html

// Web-only: configures the root HTML for every web page.
// Runs in Node.js environments during static rendering.
export default function Root({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1.00001, viewport-fit=cover"
        />
        <meta name="application-name" content="Tuition Manager" />
        <meta name="description" content="Complete tuition and coaching class management solution" />
        <meta name="google-site-verification" content="FnTndAGX4rzdc8f6zvpaV_4ich9qLQTzH_zfI8nF9I4" />
        <meta name="theme-color" content="#4f46e5" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="Tuition Manager" />

        <link rel="manifest" href="/manifest.json" />
        <link rel="apple-touch-icon" sizes="180x180" href="/pwa/apple-touch-icon-180.png" />
        <style
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{
            __html: `
html,
body,
#root {
  width: 100%;
  min-height: 100%;
  margin: 0;
  padding: 0;
}
#root {
  flex-shrink: 0;
  flex-basis: auto;
  flex-grow: 1;
  display: flex;
  flex: 1;
}
html {
  scroll-behavior: smooth;
  -webkit-text-size-adjust: 100%;
  height: calc(100% + env(safe-area-inset-top));
}
body {
  display: flex;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior-y: none;
  overscroll-behavior-x: none;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  -ms-overflow-style: scrollbar;
  -webkit-overflow-scrolling: touch;
}
`,
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
