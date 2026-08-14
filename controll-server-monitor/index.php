<?php
declare(strict_types=1);

require __DIR__ . '/includes/db.php';

$sites = csm_list_sites();
?>
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Controll Server Monitor</title>
<link rel="stylesheet" href="assets/style.css">
</head>
<body>
<nav class="csm-nav">
    <span class="csm-nav-brand">Controll Server Monitor</span>
    <a href="index.php" class="is-active">Dashboard</a>
    <a href="setup.php">Setup</a>
</nav>

<div class="csm-main">
    <div class="csm-toolbar">
        <div>
            <h2 style="margin-bottom:2px">Site Condition</h2>
            <p class="csm-description" style="margin-bottom:0">
                Probes every registered site only while this page is open and the tab is active. Nothing runs in the background.
            </p>
        </div>
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
            <?php if (!empty($sites)): ?>
                <div class="csm-view-toggle" role="group" aria-label="View">
                    <button type="button" id="csm-view-card-btn" class="csm-view-toggle-btn is-active">Card view</button>
                    <button type="button" id="csm-view-list-btn" class="csm-view-toggle-btn">List view</button>
                </div>
                <select id="csm-site-picker" class="csm-input" style="min-height:32px;width:auto" hidden>
                    <?php foreach ($sites as $site): ?>
                        <option value="<?php echo (int) $site['id']; ?>"><?php echo htmlspecialchars($site['label']); ?></option>
                    <?php endforeach; ?>
                </select>
            <?php endif; ?>
            <span id="csm-poll-status" class="csm-poll-status">Idle.</span>
            <button id="csm-refresh-btn" class="csm-btn csm-btn-primary">Refresh Now</button>
        </div>
    </div>

    <?php if (empty($sites)): ?>
        <div class="csm-panel">
            <p class="csm-empty">No sites registered yet. <a href="setup.php">Add one in Setup</a> to start monitoring.</p>
        </div>
    <?php else: ?>
        <div class="csm-grid" id="csm-grid">
            <?php foreach ($sites as $site): ?>
                <div class="csm-card" data-site-id="<?php echo (int) $site['id']; ?>">
                    <div class="csm-site-card-header">
                        <span class="csm-site-card-title"><?php echo htmlspecialchars($site['label']); ?></span>
                        <span class="csm-tier csm-tier-unknown" data-role="tier">Pending</span>
                    </div>
                    <div class="csm-site-card-meta" data-role="meta">Not probed yet</div>
                    <div class="csm-site-stat-grid" data-role="stats" hidden></div>
                </div>
            <?php endforeach; ?>
        </div>

        <div class="csm-list-view" id="csm-list-view" hidden>
            <p class="csm-description">
                Trend charts build up from probes taken during this browser session only — they start empty on page load and reset on refresh/navigation. Nothing is stored between visits.
            </p>
            <?php
            $csm_metric_rows = [
                'disk' => ['Current Disk Usage', 'Disk Used'],
                'cpu' => ['Current CPU Load', 'CPU Load'],
                'mem' => ['Current Memory Usage', 'Memory Used'],
            ];
            ?>
            <?php foreach ($csm_metric_rows as $csm_metric_key => $csm_labels): ?>
                <div class="csm-metric-row">
                    <div class="csm-metric-stat-box">
                        <div class="csm-metric-top-label"><?php echo htmlspecialchars($csm_labels[0]); ?></div>
                        <div class="csm-metric-value" data-stat="<?php echo $csm_metric_key; ?>">—</div>
                        <div class="csm-metric-detail" data-detail="<?php echo $csm_metric_key; ?>"></div>
                        <div class="csm-metric-bottom-label"><?php echo htmlspecialchars($csm_labels[1]); ?></div>
                    </div>
                    <div class="csm-metric-chart-box">
                        <div class="csm-metric-chart-title"><?php echo htmlspecialchars($csm_labels[1]); ?></div>
                        <div class="csm-metric-chart" data-chart="<?php echo $csm_metric_key; ?>"></div>
                    </div>
                </div>
            <?php endforeach; ?>
        </div>
    <?php endif; ?>
</div>

<script src="assets/dashboard.js"></script>
</body>
</html>
