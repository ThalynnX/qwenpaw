import { useEffect, useState } from "react";
import { Alert, Button, Card, Input, Space, message } from "antd";
import { useTranslation } from "react-i18next";
import { PageHeader } from "@/components/PageHeader";
import { request } from "@/api/request";

interface JevServiceStatus {
  base_url: string;
  configured: boolean;
}

export default function JevServicePage() {
  const { t } = useTranslation();
  const [baseUrl, setBaseUrl] = useState("https://api.typesafe.ai");
  const [apiKey, setApiKey] = useState("");
  const [configured, setConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void request<JevServiceStatus>("/config/jev-service")
      .then((status) => {
        setBaseUrl(status.base_url);
        setConfigured(status.configured);
      })
      .catch(() => message.error(t("jevService.loadFailed")))
      .finally(() => setLoading(false));
  }, [t]);

  const save = async () => {
    setSaving(true);
    try {
      const result = await request<JevServiceStatus>("/config/jev-service", {
        method: "PUT",
        body: JSON.stringify({
          base_url: baseUrl.trim(),
          ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}),
        }),
      });
      setBaseUrl(result.base_url);
      setConfigured(result.configured);
      setApiKey("");
      message.success(t("jevService.saved"));
    } catch {
      message.error(t("jevService.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ width: "100%" }}>
      <PageHeader current={t("nav.jevService")} />
      <Card style={{ margin: "8px 16px", borderRadius: 16 }} loading={loading}>
        <Space direction="vertical" size={16} style={{ width: "100%" }}>
          <Alert type="info" showIcon message={t("jevService.sharedHint")} />
          <label htmlFor="jev-base-url">{t("jevService.baseUrl")}</label>
          <Input
            id="jev-base-url"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder="https://api.typesafe.ai"
          />
          <label htmlFor="jev-api-key">{t("jevService.apiKey")}</label>
          <Input.Password
            id="jev-api-key"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={configured ? t("jevService.keyConfigured") : "TypeSafe API Key"}
            autoComplete="off"
          />
          <span>{configured ? t("jevService.keyConfigured") : t("jevService.keyMissing")}</span>
          <Button type="primary" onClick={() => void save()} loading={saving} disabled={!baseUrl.trim()}>
            {t("jevService.save")}
          </Button>
        </Space>
      </Card>
    </div>
  );
}
