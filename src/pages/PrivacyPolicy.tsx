import { useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";

const sections = [
  {
    title: "Information We Collect",
    body: [
      "Phone number — to identify your account and connect you with vendors.",
      "Device ID — to associate orders with your device before you add a phone number.",
      "Location — collected only in Help mode while a vendor is en route to you. We do not track location at other times.",
      "Order messages — the text you send when placing an order or booking.",
      "Delivery addresses — saved addresses you choose for delivery or home appointments.",
    ],
  },
  {
    title: "How We Use Your Information",
    body: [
      "To connect you with local vendors in your area.",
      "To deliver and track your orders from request to fulfilment.",
      "To send push notifications about order status updates.",
      "To maintain your order history and saved addresses within the app.",
    ],
  },
  {
    title: "Information Sharing",
    body: [
      "We share your phone number with a vendor only when you place an order with that vendor.",
      "We do not sell your personal data to third parties.",
      "We do not share your data with advertisers.",
    ],
  },
  {
    title: "Location Data",
    body: [
      "Location is collected only in Help mode when a vendor has accepted your request and is travelling to you.",
      "Location data is used for live tracking during the active order and is not stored permanently after the order is complete.",
    ],
  },
  {
    title: "Data Retention",
    body: [
      "Order history is retained for up to 12 months.",
      "You can clear all your data at any time from Settings → Clear My Data.",
    ],
  },
  {
    title: "Push Notifications",
    body: [
      "Push notifications are used only for order-related updates (new orders, status changes, vendor messages).",
      "You can disable notifications in your device settings at any time.",
    ],
  },
  {
    title: "Children's Privacy",
    body: [
      "Aaspaas Pro is not intended for users under the age of 13. We do not knowingly collect personal information from children.",
    ],
  },
  {
    title: "Contact Us",
    body: [
      "If you have questions about this policy or your data, contact us at privacy@aaspaas.app.",
    ],
  },
  {
    title: "Changes to This Policy",
    body: [
      "We may update this policy from time to time. We will notify users of significant changes via push notification or an in-app notice.",
    ],
  },
];

const PrivacyPolicy = () => {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-2xl mx-auto px-5 py-8 pb-12">
        <button
          type="button"
          onClick={() => navigate("/")}
          className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground mb-8 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to home
        </button>

        <header className="mb-8">
          <h1 className="font-display text-3xl font-bold tracking-tight">Aaspaas Pro</h1>
          <p className="text-lg font-semibold mt-2">Privacy Policy</p>
          <p className="text-sm text-muted-foreground mt-1">Last updated: May 2026</p>
        </header>

        <div className="space-y-8">
          {sections.map((section) => (
            <section key={section.title}>
              <h2 className="text-base font-semibold mb-3">{section.title}</h2>
              <ul className="space-y-2">
                {section.body.map((paragraph) => (
                  <li
                    key={paragraph}
                    className="text-sm text-muted-foreground leading-relaxed pl-0"
                  >
                    {paragraph}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
};

export default PrivacyPolicy;
