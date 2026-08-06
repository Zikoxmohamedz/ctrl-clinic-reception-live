# ctrl. Reception System

نظام استقبال وإدارة استهلاك المخزون متعدد الفروع، مبني بـ HTML وCSS وJavaScript وSupabase.

## التشغيل المحلي

شغّل خادماً ثابتاً من مجلد المشروع، مثلاً:

```powershell
python -m http.server 4173
```

ثم افتح `http://localhost:4173`. يتطلب النظام إعداد اتصال Supabase الصحيح ويعمل ببيانات Supabase الحقيقية فقط.

## ربط Supabase

1. أنشئ مشروع Supabase ونفّذ [database.sql](database.sql) في SQL Editor.
2. عدّل [config.js](config.js) وضع Project URL وanon key.
3. أنشئ مستخدم Auth، ثم أضف صفاً مطابقاً إلى `public.users` بنفس `id` وحدد الفرع والصلاحية.
4. انشر المجلد على Netlify؛ ملف `netlify.toml` جاهز.

بعد ترقية مشروع قائم، نفّذ [inventory-upgrade.sql](inventory-upgrade.sql) مرة واحدة في Supabase SQL Editor لإضافة جلسات الجرد المشتركة، الصلاحيات، والتحديث اللحظي. ثم أعد نشر دالة `invite-user` حتى يحصل الموظفون الجدد على صلاحية الجرد المحددة لهم.

لنظام الدعوات، انشر الدالة الآمنة:

```powershell
supabase functions deploy invite-user
```

مفتاح anon آمن للواجهة عند تفعيل RLS. لا تضع `service_role` في أي ملف بالواجهة.

## قرارات التنفيذ

- الوحدة مرتبطة بكل مادة.
- السعر المدخل هو سعر البيع فقط.
- التحويل يسجل صرفاً من الفرع المرسل؛ لا ينشئ إضافة تلقائية للفرع المستقبل.
- الأصناف المؤقتة لا تُحذف تلقائياً ويمكن للمدير تحويلها إلى دائمة.
- الطباعة مهيأة لـ A4 عبر نافذة الطباعة، ومنها يمكن الحفظ PDF.
