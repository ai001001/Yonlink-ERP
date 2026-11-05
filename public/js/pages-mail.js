'use strict';
/**
 * 企业邮箱页面：收件箱/已发送、写邮件、邮件详情与绑定、邮箱账户配置
 * Mail pages: inbox/sent, compose, detail & binding, mailbox account setup.
 */
(() => {
  const { esc, get, post, put, del, toast, modal, tableHtml, tag, can, route, setTitle, optHtml, options, readForm, download, confirmBox } = ERP;

  /** 文件大小显示 / Human-readable size */
  const size = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);

  /**
   * 写邮件弹窗 / Compose dialog.
   * @param {object} [preset] 预填内容 / prefilled values
   */
  async function compose(preset = {}) {
    const { rows: accounts } = await get('/api/mail-accounts');
    const usable = accounts.filter((a) => a.enabled);
    if (!usable.length) {
      toast('请先在「邮箱账户」中添加您的发件邮箱', 'error');
      location.hash = '#/mail-accounts';
      return;
    }
    const [customers, samples, quotes, orders] = await Promise.all([options('customer'), options('sample'), options('quote'), options('order')]);
    const labels = preset.labels || {};
    /** 保证预填的绑定值在下拉中 / keep prefilled bindings in the options */
    const withCur = (list, key) => (preset[key] && !list.some((x) => String(x.id) === String(preset[key])) ? [{ id: preset[key], label: labels[key] || `#${preset[key]}` }, ...list] : list);
    modal({
      title: preset.title || '写邮件', wide: true,
      body: `<div class="form-grid">
        <label><span class="req">发件邮箱</span><select name="account_id">${optHtml(usable.map((a) => ({ id: a.id, label: `${a.display_name ? a.display_name + ' ' : ''}<${a.email}>` })), preset.account_id || usable[0].id, false)}</select></label>
        <label class="wide"><span class="req">收件人（多个用逗号分隔）</span><input name="to" value="${esc(preset.to)}" placeholder="例如 Hans Müller <hans@homedecor.de>, ai002@316191099.xyz"></label>
        <label class="wide"><span>抄送</span><input name="cc" value="${esc(preset.cc)}"></label>
        <label class="wide"><span class="req">主题</span><input name="subject" value="${esc(preset.subject)}"></label>
        <label class="wide"><span>正文</span><textarea name="body" style="min-height:180px">${esc(preset.body)}</textarea></label>
        <label><span>绑定客户（空=按收件人自动识别）</span><select name="customer_id">${optHtml(withCur(customers, 'customer_id'), preset.customer_id)}</select></label>
        <label><span>绑定样品</span><select name="sample_id">${optHtml(withCur(samples, 'sample_id'), preset.sample_id)}</select></label>
        <label><span>绑定报价单（主题含单号可自动识别）</span><select name="quote_id">${optHtml(withCur(quotes, 'quote_id'), preset.quote_id)}</select></label>
        <label><span>绑定订单</span><select name="order_id">${optHtml(withCur(orders, 'order_id'), preset.order_id)}</select></label></div>`,
      buttons: [{
        text: '发送', cls: 'primary', onClick: async (m) => {
          try {
            await post('/api/mails/send', readForm(m.el));
            m.close();
            toast('邮件已发送并归档', 'ok');
            ERP.navigate();
          } catch (e) {
            if (e.data && e.data.mail_id) { m.close(); ERP.navigate(); }
            throw e;
          }
        },
      }],
    });
  }
  ERP.compose = compose;

  /**
   * 邮件详情弹窗 / Mail detail dialog.
   * @param {number} id
   */
  async function showMail(id) {
    const m = await get('/api/mails/' + id);
    const [customers, samples, quotes, orders] = await Promise.all([options('customer'), options('sample'), options('quote'), options('order')]);
    const editable = can('mail', 'edit');
    const dis = editable ? '' : 'disabled';
    /** 保证当前绑定值在下拉中 / keep the current binding in the options */
    const withCur = (list, key) => (m[key] && !list.some((x) => String(x.id) === String(m[key])) ? [{ id: m[key], label: m.labels[key] || `#${m[key]}` }, ...list] : list);
    const md = modal({
      title: m.subject || '(无主题)', wide: true,
      body: `<div class="kv" style="margin-bottom:10px"><div><b>发件人</b><span>${esc(m.mail_from)}</span></div><div><b>收件人</b><span>${esc(m.mail_to)}</span></div>
          ${m.mail_cc ? `<div><b>抄送</b><span>${esc(m.mail_cc)}</span></div>` : ''}<div><b>时间</b><span>${esc(m.mail_date || m.created_at)}</span></div>
          <div><b>状态</b><span>${tag(m.status || (m.direction === '收件' ? '已接收' : '已登记'))}</span></div><div><b>分类</b><span>${esc(m.category)}</span></div></div>
        ${m.error ? `<div class="alert danger">${esc(m.error)}</div>` : ''}
        <div style="white-space:pre-wrap;border:1px solid var(--line);border-radius:6px;padding:12px;max-height:340px;overflow:auto;background:var(--bg)">${esc(m.body) || '<span class="muted">（无正文）</span>'}</div>
        ${m.attachments.length ? `<h3 style="margin:12px 0 6px">附件</h3><div class="toolbar">${m.attachments.map((a) => (a.file_id
    ? `<button class="btn small" data-file="${a.file_id}">📎 ${esc(a.name)}（${size(a.size)}）</button>`
    : `<span class="tag warn">${esc(a.name)} ${esc(a.skipped || '')}</span>`)).join('')}</div>` : ''}
        <h3 style="margin:12px 0 6px">业务绑定（沟通记录随客户、样品、报价、订单永久留档）</h3>
        <div class="form-grid" id="bind">
          <label>客户<select name="customer_id" ${dis}>${optHtml(withCur(customers, 'customer_id'), m.customer_id)}</select></label>
          <label>样品<select name="sample_id" ${dis}>${optHtml(withCur(samples, 'sample_id'), m.sample_id)}</select></label>
          <label>报价单<select name="quote_id" ${dis}>${optHtml(withCur(quotes, 'quote_id'), m.quote_id)}</select></label>
          <label>订单<select name="order_id" ${dis}>${optHtml(withCur(orders, 'order_id'), m.order_id)}</select></label>
          <label>分类<select name="category" ${dis}>${optHtml(['询盘', '报价', '样品', '订单', '出货', '售后', '其它'], m.category, false)}</select></label></div>`,
      buttons: [
        ...(editable ? [{ text: '保存绑定', cls: 'primary', onClick: async (mm) => { await put('/api/e/mail/' + id, readForm(mm.el.querySelector('#bind'))); toast('绑定已保存', 'ok'); mm.close(); ERP.navigate(); } }] : []),
        ...(can('mail', 'add') && m.status === '发送失败' ? [{ text: '重新发送', onClick: async (mm) => { await post(`/api/mails/${id}/resend`); mm.close(); toast('已重新发送', 'ok'); ERP.navigate(); } }] : []),
        ...(can('mail', 'add') && m.account_id ? [{
          text: m.direction === '收件' ? '回复' : '再次发送', onClick: (mm) => {
            mm.close();
            const addr = (/<([^>]+)>/.exec(m.mail_from) || [null, m.mail_from])[1];
            compose(m.direction === '收件'
              ? { title: '回复邮件', account_id: m.account_id, to: addr, subject: /^re:/i.test(m.subject) ? m.subject : 'Re: ' + m.subject, body: `\n\n------ 原始邮件 ------\n发件人：${m.mail_from}\n时间：${m.mail_date || ''}\n\n${m.body || ''}`, customer_id: m.customer_id, sample_id: m.sample_id, quote_id: m.quote_id, order_id: m.order_id, labels: m.labels }
              : { account_id: m.account_id, to: m.mail_to, cc: m.mail_cc, subject: m.subject, body: m.body, customer_id: m.customer_id, sample_id: m.sample_id, quote_id: m.quote_id, order_id: m.order_id, labels: m.labels });
          },
        }] : []),
      ],
    });
    md.el.querySelectorAll('[data-file]').forEach((b) => { b.onclick = () => download('/api/files/' + b.dataset.file).catch((e) => toast(e.message, 'error')); });
  }

  // ---------- 邮件列表 / mail list ----------
  route(/^\/mails$/, async (_, main, qs) => {
    setTitle('业务邮件');
    const folder = qs.get('folder') || '';
    const q = qs.get('q') || '';
    const page = Number(qs.get('page') || 1);
    const data = await get(`/api/mails?folder=${encodeURIComponent(folder)}&q=${encodeURIComponent(q)}&page=${page}`);
    const folders = [['', '全部'], ['收件', '收件箱'], ['发件', '已发送'], ['发送失败', '发送失败'], ['未绑定', '未绑定客户']];
    const pages = Math.max(1, Math.ceil(data.total / 50));
    main.innerHTML = `<div class="panel"><div class="panel-head"><h2>业务邮件 <span class="muted small">共 ${data.total} 封</span></h2>
      <div class="toolbar"><input class="search" id="q" placeholder="主题/发件人/收件人/正文，回车查询" value="${esc(q)}">
        ${can('mail', 'add') ? '<button class="btn primary" id="compose">✉ 写邮件</button>' : ''}<button class="btn" id="fetchAll">⟳ 收取邮件</button>
        ${can('mail', 'add') ? '<button class="btn" id="manual">登记线下邮件</button>' : ''}<a class="btn" href="#/mail-accounts">邮箱账户</a></div></div>
      <div class="tabs">${folders.map(([k, l]) => `<button class="tab ${k === folder ? 'active' : ''}" data-folder="${k}">${l}</button>`).join('')}</div>
      ${tableHtml(['时间', '方向', '发件人 / 收件人', '主题', '分类', '绑定', '附件', '状态'], data.rows.map((m) => [
    esc(m.mail_date || m.created_at), m.direction === '收件' ? '<span class="tag info">收</span>' : '<span class="tag">发</span>',
    esc(m.direction === '收件' ? m.mail_from : m.mail_to), `<a href="#/mails" data-mail="${m.id}">${esc(m.subject || '(无主题)')}</a>`, esc(m.category),
    [m.customer_name, m.quote_no, m.order_no, m.sample_no].filter(Boolean).map((x) => `<span class="tag info">${esc(x)}</span>`).join(' ') || '<span class="muted small">未绑定</span>',
    m.attachment_count ? `📎${m.attachment_count}` : '', m.status === '发送失败' ? `<span class="tag danger" title="${esc(m.error)}">发送失败</span>` : tag(m.status)]))}
      <div class="pager"><span>第 ${page}/${pages} 页</span>
        <button class="btn small" ${page <= 1 ? 'disabled' : ''} data-page="${page - 1}">上一页</button><button class="btn small" ${page >= pages ? 'disabled' : ''} data-page="${page + 1}">下一页</button></div></div>`;
    const go = (o) => { const p = new URLSearchParams({ folder, q, page: 1, ...o }); location.hash = '#/mails?' + p.toString(); };
    main.querySelector('#q').onkeydown = (e) => { if (e.key === 'Enter') go({ q: e.target.value.trim() }); };
    main.querySelectorAll('[data-folder]').forEach((b) => { b.onclick = () => go({ folder: b.dataset.folder }); });
    main.querySelectorAll('[data-page]').forEach((b) => { b.onclick = () => go({ page: b.dataset.page }); });
    main.querySelectorAll('[data-mail]').forEach((a) => { a.onclick = (e) => { e.preventDefault(); showMail(Number(a.dataset.mail)).catch((err) => toast(err.message, 'error')); }; });
    const cb = main.querySelector('#compose');
    if (cb) cb.onclick = () => compose().catch((e) => toast(e.message, 'error'));
    main.querySelector('#fetchAll').onclick = async (e) => {
      e.target.disabled = true;
      e.target.textContent = '收取中…';
      try {
        const r = await post('/api/mail-fetch-all');
        const ok = r.results.filter((x) => x.ok);
        const bad = r.results.filter((x) => !x.ok);
        toast(`收取完成：新邮件 ${ok.reduce((s, x) => s + x.fetched, 0)} 封${bad.length ? `；${bad.map((x) => `${x.email} 失败：${x.error}`).join('；')}` : ''}`, bad.length ? 'error' : 'ok');
        ERP.navigate();
      } catch (err) {
        toast(err.message, 'error');
        e.target.disabled = false;
        e.target.textContent = '⟳ 收取邮件';
      }
    };
    const mb = main.querySelector('#manual');
    if (mb) {
      mb.onclick = async () => modal({
        title: '登记线下邮件（不经邮箱发送，仅留档）', wide: true, body: await ERP.formHtml(ERP.state.meta.entities.mail.fields, {}),
        buttons: [{ text: '保存', cls: 'primary', onClick: async (m) => { await post('/api/e/mail', readForm(m.el)); m.close(); toast('已登记', 'ok'); ERP.navigate(); } }],
      });
    }
    const open = qs.get('open');
    if (open) showMail(Number(open)).catch(() => {});
  });

  // ---------- 邮箱账户 / mailbox accounts ----------
  route(/^\/mail-accounts$/, async (_, main) => {
    setTitle('邮箱账户');
    const { rows, demo } = await get('/api/mail-accounts');
    const sec = { ssl: 'SSL', starttls: 'STARTTLS', none: '不加密' };
    main.innerHTML = `<div class="panel"><div class="panel-head"><h2>邮箱账户 <span class="muted small">${rows.length} 个</span></h2>
      ${can('mail', 'add') && !demo ? '<button class="btn primary" id="add">＋ 添加邮箱</button>' : ''}</div>
      ${demo ? '<div class="alert warn">在线演示版运行在浏览器中，无法连接真实邮箱服务器；请在正式服务器版本中配置邮箱。演示版仍可「登记线下邮件」。</div>' : ''}
      <div class="alert info">每位业务员绑定自己的企业邮箱：发出的邮件自动归档并绑定客户/报价/订单；系统定时（默认每10分钟）收取新邮件，按发件人邮箱与单号自动关联。密码加密保存，离职交接时邮件仍留在公司系统中。</div>
      ${tableHtml(['邮箱', '显示名', '使用人', '发信服务器', '收信服务器', '状态', '最近收信', '最近错误', '操作'], rows.map((a) => [esc(a.email), esc(a.display_name), esc(a.owner_name),
    `${esc(a.smtp_host)}:${a.smtp_port} ${sec[a.smtp_secure] || ''}`, `${esc(a.imap_host)}:${a.imap_port} ${sec[a.imap_secure] || ''}`, tag(a.enabled ? '启用' : '禁用'),
    esc(a.last_fetch_at), a.last_error ? `<span class="tag danger" title="${esc(a.last_error)}">${esc(a.last_error.slice(0, 30))}…</span>` : '',
    `<button class="btn small" data-test="${a.id}">测试连接</button> <button class="btn small" data-fetch="${a.id}">立即收取</button>
     ${can('mail', 'edit') ? `<button class="btn small" data-edit="${a.id}">编辑</button> <button class="btn small danger" data-del="${a.id}">删除</button>` : ''}`]))}</div>`;
    const form = async (a) => {
      const presets = (await get('/api/mail-presets')).presets;
      const users = can('system', 'edit') ? (await get('/api/users')).rows.map((u) => ({ id: u.id, label: `${u.name}（${u.username}）` })) : null;
      const m = modal({
        title: a ? '编辑邮箱账户' : '添加邮箱账户', wide: true,
        body: `<div class="toolbar" style="margin-bottom:10px"><span class="small muted">常用服务商：</span><select id="preset" style="width:200px">${optHtml(Object.keys(presets), '')}</select>
            <button class="btn small" id="detect" type="button">按邮箱自动识别</button></div>
          <div id="note"></div>
          <div class="form-grid" id="f">
            <label><span class="req">邮箱地址</span><input name="email" value="${esc(a?.email)}" placeholder="ai001@316191099.xyz"></label>
            <label><span>显示名（收件人看到的名字）</span><input name="display_name" value="${esc(a?.display_name)}"></label>
            <label><span>登录账号（空=邮箱地址）</span><input name="username" value="${esc(a?.username)}"></label>
            <label><span class="${a ? '' : 'req'}">密码 / 授权码</span><input name="password" type="password" autocomplete="new-password" placeholder="${a ? '已加密保存，留空不修改' : '多数邮箱需使用“授权码”'}"></label>
            <label><span class="req">SMTP 发信服务器</span><input name="smtp_host" value="${esc(a?.smtp_host)}"></label>
            <label><span class="req">SMTP 端口</span><input name="smtp_port" type="number" value="${esc(a?.smtp_port || 465)}"></label>
            <label><span>SMTP 加密</span><select name="smtp_secure">${optHtml([{ id: 'ssl', label: 'SSL（常用端口465）' }, { id: 'starttls', label: 'STARTTLS（常用端口587）' }, { id: 'none', label: '不加密（25，不推荐）' }], a?.smtp_secure || 'ssl', false)}</select></label>
            <label><span class="req">IMAP 收信服务器</span><input name="imap_host" value="${esc(a?.imap_host)}"></label>
            <label><span class="req">IMAP 端口</span><input name="imap_port" type="number" value="${esc(a?.imap_port || 993)}"></label>
            <label><span>IMAP 加密</span><select name="imap_secure">${optHtml([{ id: 'ssl', label: 'SSL（常用端口993）' }, { id: 'starttls', label: 'STARTTLS（常用端口143）' }, { id: 'none', label: '不加密（143，不推荐）' }], a?.imap_secure || 'ssl', false)}</select></label>
            ${users ? `<label><span>使用人</span><select name="owner_user_id">${optHtml(users, a?.owner_user_id || ERP.state.meta.user.id, false)}</select></label>` : ''}
            <label><span>自动收信</span><select name="auto_fetch">${optHtml([{ id: 1, label: '开启' }, { id: 0, label: '关闭' }], a ? a.auto_fetch : 1, false)}</select></label>
            <label><span>状态</span><select name="enabled">${optHtml([{ id: 1, label: '启用' }, { id: 0, label: '停用' }], a ? a.enabled : 1, false)}</select></label>
            <label><span>证书校验</span><select name="tls_reject_unauthorized">${optHtml([{ id: 1, label: '校验（推荐）' }, { id: 0, label: '不校验（自建/自签名服务器）' }], a ? a.tls_reject_unauthorized : 1, false)}</select></label>
          </div>`,
        buttons: [{
          text: '保存', cls: 'primary', onClick: async (mm) => {
            const body = readForm(mm.el.querySelector('#f'));
            const saved = a ? await put('/api/mail-accounts/' + a.id, body) : await post('/api/mail-accounts', body);
            mm.close();
            toast('已保存，正在测试连接…', 'ok');
            const t = await post(`/api/mail-accounts/${saved.id}/test`);
            toast(`${t.smtp.message}；${t.imap.message}`, t.smtp.ok && t.imap.ok ? 'ok' : 'error');
            ERP.navigate();
          },
        }],
      });
      const f = m.el.querySelector('#f');
      const fill = (p) => { for (const [k, v] of Object.entries(p)) { const el = f.querySelector(`[name="${k}"]`); if (el) el.value = v; } };
      m.el.querySelector('#preset').onchange = (e) => { if (presets[e.target.value]) fill(presets[e.target.value]); };
      m.el.querySelector('#detect').onclick = async () => {
        const email = f.querySelector('[name=email]').value.trim();
        if (!email) { toast('请先填写邮箱地址', 'error'); return; }
        const r = await get('/api/mail-presets?email=' + encodeURIComponent(email));
        if (r.suggestion) { fill(r.presets[r.suggestion]); m.el.querySelector('#preset').value = r.suggestion; }
        m.el.querySelector('#note').innerHTML = r.note ? `<div class="alert ${r.suggestion ? 'info' : 'warn'}">${esc(r.note)}</div>` : '';
      };
    };
    const ab = main.querySelector('#add');
    if (ab) ab.onclick = () => form(null).catch((e) => toast(e.message, 'error'));
    main.querySelectorAll('[data-edit]').forEach((b) => { b.onclick = () => form(rows.find((x) => x.id === Number(b.dataset.edit))); });
    main.querySelectorAll('[data-test]').forEach((b) => {
      b.onclick = async () => {
        b.disabled = true;
        try {
          const t = await post(`/api/mail-accounts/${b.dataset.test}/test`);
          modal({ title: '连接测试结果', body: `<div class="alert ${t.smtp.ok ? 'info' : 'danger'}"><span class="t">发信 SMTP</span>${esc(t.smtp.message)}</div><div class="alert ${t.imap.ok ? 'info' : 'danger'}"><span class="t">收信 IMAP</span>${esc(t.imap.message)}</div>` });
        } catch (e) { toast(e.message, 'error'); } finally { b.disabled = false; }
      };
    });
    main.querySelectorAll('[data-fetch]').forEach((b) => {
      b.onclick = async () => {
        b.disabled = true;
        try { const r = await post(`/api/mail-accounts/${b.dataset.fetch}/fetch`); toast(`收到新邮件 ${r.fetched} 封`, 'ok'); ERP.navigate(); } catch (e) { toast(e.message, 'error'); b.disabled = false; }
      };
    });
    main.querySelectorAll('[data-del]').forEach((b) => {
      b.onclick = async () => { if (await confirmBox('删除该邮箱账户？已收发的邮件记录会保留。')) { await del('/api/mail-accounts/' + b.dataset.del); ERP.navigate(); } };
    });
  });
})();
