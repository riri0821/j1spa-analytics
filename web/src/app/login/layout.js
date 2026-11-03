// login/page.js is a Client Component, which cannot export `metadata` - so
// the title for this route lives in a layout, which is a Server Component.
export const metadata = { title: "Login" };

export default function LoginLayout({ children }) {
  return children;
}
