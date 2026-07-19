import { Link, useLocation } from "react-router-dom";
import { useEffect } from "react";
import { useLanguage } from "@/lib/language";

const NotFound = () => {
  const location = useLocation();
  const { s } = useLanguage();

  useEffect(() => {
    console.error("404 Error: User attempted to access non-existent route:", location.pathname);
  }, [location.pathname]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted" data-testid="not-found-page">
      <div className="text-center">
        <h1 className="mb-4 text-4xl font-bold">404</h1>
        <p className="mb-4 text-xl text-muted-foreground">{s.not_found_message}</p>
        <Link to="/" className="text-primary underline hover:text-primary/90">
          {s.not_found_home}
        </Link>
      </div>
    </div>
  );
};

export default NotFound;
