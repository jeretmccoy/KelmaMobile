/* eslint-env jest, node */
// Native WebView ships untranspiled ESM that Jest does not transform from
// node_modules. Tests exercise our screen behavior, not WKWebView itself.
jest.mock('react-native-webview', () => {
  const React = require('react');
  const WebView = React.forwardRef((props, ref) =>
    React.createElement('WebView', { ...props, ref }, props.children),
  );
  WebView.displayName = 'WebView';
  return { __esModule: true, WebView, default: WebView };
});
