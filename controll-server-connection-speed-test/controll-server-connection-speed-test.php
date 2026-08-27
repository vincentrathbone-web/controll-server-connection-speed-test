<?php
/**
 * Plugin Name: Controll Server Connection Speed Test
 * Description: Measures connection quality between your browser and this WordPress server (latency, jitter, download, upload).
 * Version: 1.7.8
 * Author: Controll
 * License: GPL-2.0-or-later
 * Text Domain: controll-server-connection-speed-test
 */

if (!defined('ABSPATH')) {
    exit;
}

// Kept in sync with the "Version:" header above by package.ps1 on every release
// bump, and surfaced in the admin screen and the remote monitoring API so a
// central dashboard (or the desktop app) can tell which sites are outdated.
define('CSST_PLUGIN_VERSION', '1.7.8');

final class CSST_Plugin {
    private const SLUG = 'controll-server-connection-speed-test';
    private const NONCE_ACTION = 'csst_speed_test_nonce';
    private const HISTORY_OPTION = 'csst_speed_test_history';
    private const MAX_HISTORY_ITEMS = 200;
    private const DIAGNOSTICS_HISTORY_OPTION = 'csst_diagnostics_history';
    private const MAX_DIAGNOSTICS_HISTORY_ITEMS = 200;
    private const DISK_ALERT_THRESHOLD_PERCENT = 90.0;
    private const DISK_MONITOR_CRON_HOOK = 'csst_disk_monitor_check';
    private const DISK_MONITOR_STATUS_OPTION = 'csst_disk_monitor_status';
    private const API_KEY_OPTION = 'csst_api_key';
    private const REST_NAMESPACE = 'csst/v1';
    private const CPANEL_USERNAME_OPTION = 'csst_cpanel_username';
    private const CPANEL_API_TOKEN_OPTION = 'csst_cpanel_api_token';
    private const CPANEL_HOST_OPTION = 'csst_cpanel_host';
    private const CPANEL_SHELL_QUOTA_CACHE_OPTION = 'csst_cpanel_shell_quota_cache';
    private const CPANEL_SHELL_QUOTA_CRON_HOOK = 'csst_cpanel_shell_quota_refresh';
    private const CPANEL_LVE_USAGE_TRANSIENT = 'csst_cpanel_lve_usage';

    public static function init(): void {
        add_action('admin_menu', [self::class, 'register_menu']);
        add_action('admin_enqueue_scripts', [self::class, 'enqueue_assets']);
        add_action('rest_api_init', [self::class, 'register_rest_routes']);

        // Hardening plugins/snippets that lock the whole REST API behind a
        // login (e.g. the "Members" plugin's Private REST API option) reject
        // requests via this same filter before routing/permission_callback
        // ever runs — which would make our already API-key-gated endpoint
        // unreachable no matter how correct the key is. Run late (priority
        // 999) so we see whatever error such a plugin already set, and only
        // clear it for our own namespace when a valid key is presented;
        // every other route's lockdown is left untouched.
        add_filter('rest_authentication_errors', [self::class, 'bypass_rest_lockdown_for_valid_api_key'], 999);

        add_action('wp_ajax_csst_ping', [self::class, 'ajax_ping']);
        add_action('wp_ajax_csst_download', [self::class, 'ajax_download']);
        add_action('wp_ajax_csst_upload', [self::class, 'ajax_upload']);
        add_action('wp_ajax_csst_history_add', [self::class, 'ajax_history_add']);
        add_action('wp_ajax_csst_history_list', [self::class, 'ajax_history_list']);
        add_action('wp_ajax_csst_server_diagnostics', [self::class, 'ajax_server_diagnostics']);
        add_action('wp_ajax_csst_diagnostics_history_list', [self::class, 'ajax_diagnostics_history_list']);
        add_action('wp_ajax_csst_process_list', [self::class, 'ajax_process_list']);
        add_action('wp_ajax_csst_download_keep_alive_script', [self::class, 'ajax_download_keep_alive_script']);
        add_action('wp_ajax_csst_live_stats', [self::class, 'ajax_live_stats']);
        add_action('wp_ajax_csst_generate_api_key', [self::class, 'ajax_generate_api_key']);
        add_action('wp_ajax_csst_revoke_api_key', [self::class, 'ajax_revoke_api_key']);
        add_action('wp_ajax_csst_save_cpanel_settings', [self::class, 'ajax_save_cpanel_settings']);
        add_action('wp_ajax_csst_clear_cpanel_settings', [self::class, 'ajax_clear_cpanel_settings']);
        add_action('wp_ajax_csst_test_cpanel_quota', [self::class, 'ajax_test_cpanel_quota']);
        add_action('wp_ajax_csst_refresh_cpanel_shell_quota', [self::class, 'ajax_refresh_cpanel_shell_quota']);

        add_action(self::DISK_MONITOR_CRON_HOOK, [self::class, 'run_disk_monitor_check']);

        if (!wp_next_scheduled(self::DISK_MONITOR_CRON_HOOK)) {
            wp_schedule_event(time(), 'hourly', self::DISK_MONITOR_CRON_HOOK);
        }

        add_action(self::CPANEL_SHELL_QUOTA_CRON_HOOK, [self::class, 'refresh_cpanel_shell_quota_cache']);

        if (!wp_next_scheduled(self::CPANEL_SHELL_QUOTA_CRON_HOOK)) {
            wp_schedule_event(time(), 'hourly', self::CPANEL_SHELL_QUOTA_CRON_HOOK);
        }
    }

    public static function register_rest_routes(): void {
        register_rest_route(self::REST_NAMESPACE, '/stats', [
            'methods' => 'GET',
            'callback' => [self::class, 'rest_get_stats'],
            'permission_callback' => [self::class, 'rest_verify_api_key'],
        ]);
    }

    private static function get_api_key(): string {
        $key = get_option(self::API_KEY_OPTION, '');
        return is_string($key) ? $key : '';
    }

    /**
     * @return true|WP_Error
     */
    public static function rest_verify_api_key(WP_REST_Request $request) {
        $stored = self::get_api_key();
        if ($stored === '') {
            return new WP_Error('csst_not_configured', 'Remote monitoring is not enabled on this site.', ['status' => 403]);
        }

        $provided = $request->get_header('x-csst-api-key');
        if (!is_string($provided) || $provided === '' || !hash_equals($stored, $provided)) {
            return new WP_Error('csst_forbidden', 'Invalid or missing API key.', ['status' => 401]);
        }

        return true;
    }

    /**
     * @param true|WP_Error|null $result Whatever an earlier rest_authentication_errors
     *                                    filter (e.g. a site-wide "require login for all
     *                                    REST requests" hardening plugin) already decided.
     * @return true|WP_Error|null
     */
    public static function bypass_rest_lockdown_for_valid_api_key($result) {
        if (!is_wp_error($result)) {
            // Nothing to bypass — either no lockdown is active, or an earlier
            // filter already approved the request.
            return $result;
        }

        // Only ever act on requests actually aimed at our own namespace, so
        // this can't be used to slip past the lockdown for anything else.
        $uri = isset($_SERVER['REQUEST_URI']) ? rawurldecode((string) $_SERVER['REQUEST_URI']) : '';
        if (strpos($uri, '/' . self::REST_NAMESPACE . '/') === false) {
            return $result;
        }

        $stored = self::get_api_key();
        $provided = isset($_SERVER['HTTP_X_CSST_API_KEY']) ? (string) $_SERVER['HTTP_X_CSST_API_KEY'] : '';

        if ($stored !== '' && $provided !== '' && hash_equals($stored, $provided)) {
            return true;
        }

        return $result;
    }

    public static function rest_get_stats(WP_REST_Request $request): WP_REST_Response {
        $data = self::compute_diagnostics();
        $data['live'] = self::compute_live_stats();

        $response = new WP_REST_Response($data, 200);
        $response->header('Cache-Control', 'no-store');

        return $response;
    }

    public static function ajax_generate_api_key(): void {
        self::verify_request();

        $key = bin2hex(random_bytes(32));
        update_option(self::API_KEY_OPTION, $key, false);

        wp_send_json_success([
            'apiKey' => $key,
            'endpointUrl' => rest_url(self::REST_NAMESPACE . '/stats'),
        ]);
    }

    public static function ajax_revoke_api_key(): void {
        self::verify_request();

        delete_option(self::API_KEY_OPTION);

        wp_send_json_success([
            'apiKey' => '',
            'endpointUrl' => rest_url(self::REST_NAMESPACE . '/stats'),
        ]);
    }

    public static function ajax_save_cpanel_settings(): void {
        self::verify_request();

        $username = sanitize_text_field((string) ($_POST['cpanel_username'] ?? ''));
        $host = sanitize_text_field((string) ($_POST['cpanel_host'] ?? ''));
        $token = trim((string) ($_POST['cpanel_api_token'] ?? ''));

        update_option(self::CPANEL_USERNAME_OPTION, $username, false);
        update_option(self::CPANEL_HOST_OPTION, $host, false);
        if ($token !== '') {
            // The token field is left blank on page reload so it's never echoed
            // back to the browser; only overwrite the stored token if a new one
            // was actually typed.
            update_option(self::CPANEL_API_TOKEN_OPTION, $token, false);
        }

        wp_send_json_success([
            'username' => $username,
            'host' => $host,
            'hasToken' => ((string) get_option(self::CPANEL_API_TOKEN_OPTION, '')) !== '',
        ]);
    }

    public static function ajax_clear_cpanel_settings(): void {
        self::verify_request();

        delete_option(self::CPANEL_USERNAME_OPTION);
        delete_option(self::CPANEL_API_TOKEN_OPTION);
        delete_option(self::CPANEL_HOST_OPTION);

        wp_send_json_success();
    }

    public static function ajax_test_cpanel_quota(): void {
        self::verify_request();

        $username = sanitize_text_field((string) ($_POST['cpanel_username'] ?? ''));
        $host = sanitize_text_field((string) ($_POST['cpanel_host'] ?? ''));
        $token = trim((string) ($_POST['cpanel_api_token'] ?? ''));

        if ($username === '') {
            $username = (string) get_option(self::CPANEL_USERNAME_OPTION, '');
        }
        if ($host === '') {
            $host = (string) get_option(self::CPANEL_HOST_OPTION, '');
        }
        if ($token === '') {
            // Testing already-saved credentials without retyping the secret.
            $token = (string) get_option(self::CPANEL_API_TOKEN_OPTION, '');
        }

        $result = self::fetch_cpanel_quota($username, $token, $host);

        if (isset($result['error'])) {
            wp_send_json_error(['message' => $result['error']]);
            return;
        }

        wp_send_json_success($result);
    }

    public static function ajax_refresh_cpanel_shell_quota(): void {
        self::verify_request();

        self::refresh_cpanel_shell_quota_cache();
        $result = self::get_cpanel_shell_quota_cached();

        if (isset($result['error'])) {
            wp_send_json_error(['message' => $result['error']]);
            return;
        }

        wp_send_json_success($result);
    }

    public static function activate(): void {
        if (!wp_next_scheduled(self::DISK_MONITOR_CRON_HOOK)) {
            wp_schedule_event(time(), 'hourly', self::DISK_MONITOR_CRON_HOOK);
        }
        if (!wp_next_scheduled(self::CPANEL_SHELL_QUOTA_CRON_HOOK)) {
            wp_schedule_event(time(), 'hourly', self::CPANEL_SHELL_QUOTA_CRON_HOOK);
        }
    }

    public static function deactivate(): void {
        $timestamp = wp_next_scheduled(self::DISK_MONITOR_CRON_HOOK);
        if ($timestamp) {
            wp_unschedule_event($timestamp, self::DISK_MONITOR_CRON_HOOK);
        }
        $shellQuotaTimestamp = wp_next_scheduled(self::CPANEL_SHELL_QUOTA_CRON_HOOK);
        if ($shellQuotaTimestamp) {
            wp_unschedule_event($shellQuotaTimestamp, self::CPANEL_SHELL_QUOTA_CRON_HOOK);
        }
    }

    public static function register_menu(): void {
        add_menu_page(
            __('Server Speed Test', 'controll-server-connection-speed-test'),
            __('Server Speed Test', 'controll-server-connection-speed-test'),
            'manage_options',
            self::SLUG,
            [self::class, 'render_admin_page'],
            'dashicons-performance',
            81
        );
    }

    public static function enqueue_assets(string $hook_suffix): void {
        if ($hook_suffix !== 'toplevel_page_' . self::SLUG) {
            return;
        }

        $css_version = file_exists(plugin_dir_path(__FILE__) . 'assets/css/admin.css')
            ? (string) filemtime(plugin_dir_path(__FILE__) . 'assets/css/admin.css')
            : '1.0.0';

        $js_version = file_exists(plugin_dir_path(__FILE__) . 'assets/js/admin.js')
            ? (string) filemtime(plugin_dir_path(__FILE__) . 'assets/js/admin.js')
            : '1.0.0';

        wp_enqueue_style(
            'csst-admin-style',
            plugin_dir_url(__FILE__) . 'assets/css/admin.css',
            [],
            $css_version
        );

        wp_enqueue_script(
            'csst-admin-script',
            plugin_dir_url(__FILE__) . 'assets/js/admin.js',
            [],
            $js_version,
            true
        );

        wp_localize_script('csst-admin-script', 'CSSTConfig', [
            'ajaxUrl' => admin_url('admin-ajax.php'),
            'nonce' => wp_create_nonce(self::NONCE_ACTION),
            'defaults' => [
                'pingCount' => 8,
                'downloadDurationSec' => 8,
                'uploadDurationSec' => 8,
                'downloadParallel' => 3,
                'downloadChunkBytes' => 1000000,
                'uploadChunkBytes' => 1000000,
            ],
        ]);
    }

    public static function render_admin_page(): void {
        if (!current_user_can('manage_options')) {
            wp_die(esc_html__('You do not have permission to access this page.', 'controll-server-connection-speed-test'));
        }
        ?>
        <div class="wrap csst-wrap">
            <nav class="csst-nav">
                <span class="csst-nav-brand"><?php echo esc_html__('ServerPulse', 'controll-server-connection-speed-test'); ?></span>
                <span class="csst-nav-tagline"><?php echo esc_html__('Server Speed & Diagnostics', 'controll-server-connection-speed-test'); ?></span>
                <span class="csst-nav-version"><?php echo esc_html(sprintf(
                    /* translators: %s: plugin version number */
                    __('Plugin v%s', 'controll-server-connection-speed-test'),
                    CSST_PLUGIN_VERSION
                )); ?></span>
            </nav>

            <div class="csst-tabs-row">
                <div class="csst-tabs" role="tablist" aria-label="CSST tabs">
                    <button id="csst-tab-overview" class="csst-tab-button is-active" data-target="csst-view-overview" role="tab" aria-selected="true">
                        <?php echo esc_html__('Connection & Diagnostics', 'controll-server-connection-speed-test'); ?>
                    </button>
                    <button id="csst-tab-processes" class="csst-tab-button" data-target="csst-view-processes" role="tab" aria-selected="false">
                        <?php echo esc_html__('Process Monitor', 'controll-server-connection-speed-test'); ?>
                    </button>
                </div>
                <a href="https://github.com/vincentrathbone-web/controll-server-connection-speed-test/releases/latest" target="_blank" rel="noopener noreferrer" class="csst-companion-link">
                    <svg class="csst-ico" width="16" height="16" viewBox="0 0 24 24"><path d="M12 3 V15 M7 10 L12 15 L17 10 M5 21 H19"></path></svg>
                    <?php echo esc_html__('Download Desktop App', 'controll-server-connection-speed-test'); ?>
                </a>
            </div>

            <div id="csst-view-overview" class="csst-tab-view">

            <section class="csst-panel csst-banner" id="csst-banner">
                <div class="csst-banner-left">
                    <div class="csst-banner-icon csst-tier-unknown" id="csst-banner-icon">
                        <svg class="csst-ico" width="28" height="28" viewBox="0 0 24 24"><path id="csst-banner-icon-path" d=""></path></svg>
                    </div>
                    <div>
                        <div class="csst-card-kicker"><?php echo esc_html__('Overall server rating', 'controll-server-connection-speed-test'); ?></div>
                        <h2 id="csst-banner-label"><?php echo esc_html__('Not run yet', 'controll-server-connection-speed-test'); ?></h2>
                        <p class="csst-card-body" id="csst-banner-summary"><?php echo esc_html__('Run diagnostics to see the current server rating.', 'controll-server-connection-speed-test'); ?></p>
                    </div>
                </div>
                <button id="csst-run-diagnostics" class="button button-primary">
                    <svg class="csst-ico" width="16" height="16" viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-3-6.7 M21 3 V9 H15"></path></svg>
                    <?php echo esc_html__('Run Diagnostics', 'controll-server-connection-speed-test'); ?>
                </button>
            </section>

            <section class="csst-panel">
                <h3><?php echo esc_html__('Server Specs', 'controll-server-connection-speed-test'); ?></h3>
                <div class="csst-specs-grid" id="csst-specs-grid">
                    <div class="csst-card csst-spec-card"><div class="csst-spec-value">-</div></div>
                    <div class="csst-card csst-spec-card"><div class="csst-spec-value">-</div></div>
                    <div class="csst-card csst-spec-card"><div class="csst-spec-value">-</div></div>
                    <div class="csst-card csst-spec-card"><div class="csst-spec-value">-</div></div>
                    <div class="csst-card csst-spec-card"><div class="csst-spec-value">-</div></div>
                </div>
            </section>

            <section class="csst-panel">
                <h3><?php echo esc_html__('Live Resource Usage', 'controll-server-connection-speed-test'); ?></h3>
                <p class="description">
                    <?php echo esc_html__('Polls every 2 seconds only while this page is open and the browser tab is active; stops when you leave or switch away. On CloudLinux/LVE shared hosting, automatically uses this account\'s own CPU/memory limits instead of the whole server\'s. Otherwise, CPU falls back to system-wide load average, and Memory falls back to this WordPress installation\'s own PHP memory usage against its memory_limit (not the whole server\'s RAM) — shows n/a if unavailable.', 'controll-server-connection-speed-test'); ?>
                </p>
                <div class="csst-live-grid">
                    <div class="csst-card csst-live-card">
                        <div class="csst-metric-head">
                            <span class="csst-metric-title"><?php echo esc_html__('CPU Load', 'controll-server-connection-speed-test'); ?></span>
                            <span id="csst-live-cpu-value" class="csst-live-value">-</span>
                        </div>
                        <canvas id="csst-live-cpu-chart" class="csst-sparkline" width="400" height="70"></canvas>
                    </div>
                    <div class="csst-card csst-live-card">
                        <div class="csst-metric-head">
                            <span class="csst-metric-title"><?php echo esc_html__('Memory Used', 'controll-server-connection-speed-test'); ?></span>
                            <span id="csst-live-ram-value" class="csst-live-value">-</span>
                        </div>
                        <canvas id="csst-live-ram-chart" class="csst-sparkline" width="400" height="70"></canvas>
                    </div>
                </div>
            </section>

            <?php $csst_duplicator = self::get_duplicator_backup_status(); ?>
            <section class="csst-panel">
                <h3><?php echo esc_html__('Duplicator Pro Backup', 'controll-server-connection-speed-test'); ?></h3>
                <p class="description">
                    <?php echo esc_html__('Last backup attempt recorded by Duplicator Pro on this site, if installed. Refreshes whenever diagnostics run.', 'controll-server-connection-speed-test'); ?>
                </p>
                <div id="csst-duplicator-status" class="csst-status">
                    <?php echo wp_kses(self::render_duplicator_status_html($csst_duplicator), [
                        'span' => ['class' => true, 'id' => true],
                    ]); ?>
                </div>
            </section>

            <section class="csst-panel">
                <div class="csst-panel-header">
                    <h3><?php echo esc_html__('Server Diagnostics Snapshot', 'controll-server-connection-speed-test'); ?></h3>
                </div>
                <p class="description">
                    <?php echo esc_html__('Useful when response is slow: database round-trip, PHP benchmark, memory, disk, and load average.', 'controll-server-connection-speed-test'); ?>
                </p>
                <div id="csst-diagnostics-status" class="csst-status"><?php echo esc_html__('Diagnostics not run yet.', 'controll-server-connection-speed-test'); ?></div>
                <div class="csst-metrics-grid" id="csst-metrics-grid"></div>
                <details class="csst-card csst-raw-details" style="margin-top:12px">
                    <summary><?php echo esc_html__('Raw metrics (JSON)', 'controll-server-connection-speed-test'); ?></summary>
                    <pre id="csst-diagnostics-output" class="csst-raw-json"></pre>
                </details>
            </section>

            <section class="csst-panel">
                <h3><?php echo esc_html__('Trend Comparison', 'controll-server-connection-speed-test'); ?></h3>
                <p class="description">
                    <?php echo esc_html__('Rolling averages help identify peak-hour degradation.', 'controll-server-connection-speed-test'); ?>
                </p>
                <div class="csst-comparison-grid">
                    <div class="csst-card" id="csst-window-1h">
                        <div class="csst-card-kicker"><?php echo esc_html__('Last 1 Hour', 'controll-server-connection-speed-test'); ?></div>
                        <pre class="csst-window-metrics">-</pre>
                    </div>
                    <div class="csst-card" id="csst-window-24h">
                        <div class="csst-card-kicker"><?php echo esc_html__('Last 24 Hours', 'controll-server-connection-speed-test'); ?></div>
                        <pre class="csst-window-metrics">-</pre>
                    </div>
                    <div class="csst-card" id="csst-window-7d">
                        <div class="csst-card-kicker"><?php echo esc_html__('Last 7 Days', 'controll-server-connection-speed-test'); ?></div>
                        <pre class="csst-window-metrics">-</pre>
                    </div>
                </div>
            </section>

            <section class="csst-panel">
                <div class="csst-panel-header">
                    <h3><?php echo esc_html__('Speed Test History', 'controll-server-connection-speed-test'); ?></h3>
                    <div style="display:flex;gap:8px">
                        <button id="csst-start" class="button button-primary">
                            <svg class="csst-ico" width="16" height="16" viewBox="0 0 24 24"><path d="M12 2 a10 10 0 1 0 0.001 0 M12 12 L15.5 8.5 M12 12 m-1.5 0 a1.5 1.5 0 1 0 3 0 a1.5 1.5 0 1 0 -3 0"></path></svg>
                            <?php echo esc_html__('Run Speed Test', 'controll-server-connection-speed-test'); ?>
                        </button>
                        <button id="csst-stop" class="button button-secondary" disabled>
                            <?php echo esc_html__('Stop', 'controll-server-connection-speed-test'); ?>
                        </button>
                        <button id="csst-export-csv" class="button button-secondary" disabled>
                            <svg class="csst-ico" width="16" height="16" viewBox="0 0 24 24"><path d="M12 3 V15 M7 10 L12 15 L17 10 M5 21 H19"></path></svg>
                            <?php echo esc_html__('Export CSV', 'controll-server-connection-speed-test'); ?>
                        </button>
                    </div>
                </div>
                <div id="csst-status" class="csst-status" aria-live="polite">
                    <?php echo esc_html__('Idle.', 'controll-server-connection-speed-test'); ?>
                </div>
                <div class="csst-results">
                    <div class="csst-card csst-result-card">
                        <h4><?php echo esc_html__('Latency', 'controll-server-connection-speed-test'); ?></h4>
                        <div id="csst-latency" class="csst-result-value">-</div>
                    </div>
                    <div class="csst-card csst-result-card">
                        <h4><?php echo esc_html__('Jitter', 'controll-server-connection-speed-test'); ?></h4>
                        <div id="csst-jitter" class="csst-result-value">-</div>
                    </div>
                    <div class="csst-card csst-result-card">
                        <h4><?php echo esc_html__('Download', 'controll-server-connection-speed-test'); ?></h4>
                        <div id="csst-download" class="csst-result-value">-</div>
                    </div>
                    <div class="csst-card csst-result-card">
                        <h4><?php echo esc_html__('Upload', 'controll-server-connection-speed-test'); ?></h4>
                        <div id="csst-upload" class="csst-result-value">-</div>
                    </div>
                </div>
                <pre id="csst-summary" class="csst-summary" hidden></pre>
                <p class="description" style="margin-top:12px"><?php echo esc_html__('Latest result is shown first. Click a row to see full detail; click a sortable column to reorder.', 'controll-server-connection-speed-test'); ?></p>
                <div class="csst-table-wrap">
                    <table class="csst-table" id="csst-history-table">
                        <thead>
                            <tr>
                                <th class="csst-sortable" data-sort="dt"><?php echo esc_html__('Date/Time', 'controll-server-connection-speed-test'); ?></th>
                                <th class="csst-sortable" data-sort="latencyMs"><?php echo esc_html__('Latency', 'controll-server-connection-speed-test'); ?></th>
                                <th class="csst-sortable" data-sort="downloadMbps"><?php echo esc_html__('Download', 'controll-server-connection-speed-test'); ?></th>
                                <th class="csst-sortable" data-sort="uploadMbps"><?php echo esc_html__('Upload', 'controll-server-connection-speed-test'); ?></th>
                                <th><?php echo esc_html__('Quality', 'controll-server-connection-speed-test'); ?></th>
                                <th></th>
                            </tr>
                        </thead>
                        <tbody id="csst-history-body">
                            <tr>
                                <td colspan="6"><?php echo esc_html__('No tests yet.', 'controll-server-connection-speed-test'); ?></td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </section>

            <section class="csst-panel">
                <h3><?php echo esc_html__('Plugin Load Correlation', 'controll-server-connection-speed-test'); ?></h3>
                <p class="description">
                    <?php echo esc_html__('Each time diagnostics run, active plugin count is recorded alongside query count/time, peak memory, and benchmark timings, so you can see whether more plugins correlate with slower server-side metrics.', 'controll-server-connection-speed-test'); ?>
                </p>
                <div id="csst-plugin-load-status" class="csst-status"><?php echo esc_html__('No diagnostics runs recorded yet.', 'controll-server-connection-speed-test'); ?></div>
                <div class="csst-table-wrap">
                    <table class="csst-table">
                        <thead>
                            <tr>
                                <th><?php echo esc_html__('Date/Time', 'controll-server-connection-speed-test'); ?></th>
                                <th><?php echo esc_html__('Active Plugins', 'controll-server-connection-speed-test'); ?></th>
                                <th><?php echo esc_html__('Query Count', 'controll-server-connection-speed-test'); ?></th>
                                <th><?php echo esc_html__('Query Time', 'controll-server-connection-speed-test'); ?></th>
                                <th><?php echo esc_html__('Peak Memory', 'controll-server-connection-speed-test'); ?></th>
                                <th><?php echo esc_html__('DB Round-Trip', 'controll-server-connection-speed-test'); ?></th>
                                <th><?php echo esc_html__('PHP Benchmark', 'controll-server-connection-speed-test'); ?></th>
                                <th><?php echo esc_html__('Overall', 'controll-server-connection-speed-test'); ?></th>
                            </tr>
                        </thead>
                        <tbody id="csst-plugin-load-body">
                            <tr>
                                <td colspan="8"><?php echo esc_html__('No diagnostics runs recorded yet.', 'controll-server-connection-speed-test'); ?></td>
                            </tr>
                        </tbody>
                    </table>
                </div>
                <p class="description">
                    <?php echo esc_html__('Query Count and Query Time require SAVEQUERIES to be enabled in wp-config.php; otherwise they show as n/a.', 'controll-server-connection-speed-test'); ?>
                </p>
            </section>

            <section class="csst-panel">
                <div class="csst-panel-header">
                    <h3><?php echo esc_html__('Keep Server Awake', 'controll-server-connection-speed-test'); ?></h3>
                    <button id="csst-download-keep-alive" class="button button-secondary">
                        <?php echo esc_html__('Download Keep-Alive Script', 'controll-server-connection-speed-test'); ?>
                    </button>
                </div>
                <p class="description">
                    <?php echo esc_html__('Downloads a Windows PowerShell script pre-configured with this site\'s URL. Run it once and it installs a Windows Scheduled Task that pings this site every few minutes so a shared host does not put it to sleep. Safe to re-download and re-run any time, including after reinstalling Windows.', 'controll-server-connection-speed-test'); ?>
                </p>
            </section>

            <?php
            $csst_cpanel_username = (string) get_option(self::CPANEL_USERNAME_OPTION, '');
            $csst_cpanel_host = (string) get_option(self::CPANEL_HOST_OPTION, '');
            $csst_cpanel_has_token = ((string) get_option(self::CPANEL_API_TOKEN_OPTION, '')) !== '';
            $csst_cpanel_configured = $csst_cpanel_username !== '' && $csst_cpanel_host !== '' && $csst_cpanel_has_token;
            $csst_shell_quota = get_option(self::CPANEL_SHELL_QUOTA_CACHE_OPTION, null);
            $csst_shell_ok = is_array($csst_shell_quota) && !isset($csst_shell_quota['error']) && !($csst_shell_quota['unlimited'] ?? false);
            ?>
            <section class="csst-panel">
                <div class="csst-panel-header">
                    <h3><?php echo esc_html__('Hosting Disk Quota (cPanel)', 'controll-server-connection-speed-test'); ?></h3>
                </div>
                <p class="description">
                    <?php echo esc_html__('By default, Disk Space above reports this server\'s total filesystem, which on shared hosting is usually far bigger than your actual package allocation.', 'controll-server-connection-speed-test'); ?>
                </p>
                <div id="csst-cpanel-shell-status" class="csst-status" style="margin-bottom:12px;padding:10px 12px;border-radius:2px;background:<?php echo $csst_shell_ok ? 'var(--csst-tier-good-bg)' : 'var(--csst-tier-warn-bg)'; ?>">
                    <span id="csst-cpanel-shell-status-text">
                        <?php if ($csst_shell_ok): ?>
                            <?php echo esc_html(sprintf(
                                /* translators: 1: used size, 2: total size, 3: percent used, 4: last-checked timestamp */
                                __('Auto-detected via local system access — no configuration needed. %1$s used of %2$s (%3$s%%). Last checked %4$s.', 'controll-server-connection-speed-test'),
                                size_format((int) $csst_shell_quota['usedBytes']),
                                size_format((int) $csst_shell_quota['totalBytes']),
                                $csst_shell_quota['usedPercent'],
                                $csst_shell_quota['checkedAt'] ?? 'n/a'
                            )); ?>
                        <?php elseif (is_array($csst_shell_quota) && isset($csst_shell_quota['error'])): ?>
                            <?php echo esc_html(sprintf(
                                /* translators: %s: the error reported by the local auto-detection attempt */
                                __('Not auto-detected on this host: %s Configure manually below as a fallback.', 'controll-server-connection-speed-test'),
                                $csst_shell_quota['error']
                            )); ?>
                        <?php else: ?>
                            <?php echo esc_html__('Checking for local auto-detection…', 'controll-server-connection-speed-test'); ?>
                        <?php endif; ?>
                    </span>
                    <button type="button" id="csst-refresh-cpanel-shell" class="button button-secondary" style="margin-left:8px">
                        <?php echo esc_html__('Check Now', 'controll-server-connection-speed-test'); ?>
                    </button>
                </div>
                <p class="description">
                    <?php echo esc_html__('Manual fallback — only used if auto-detection above isn\'t available on this host (e.g. shell_exec disabled):', 'controll-server-connection-speed-test'); ?>
                </p>
                <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:12px">
                    <div class="csst-api-field" style="flex:1;min-width:180px">
                        <label for="csst-cpanel-username"><?php echo esc_html__('cPanel Username', 'controll-server-connection-speed-test'); ?></label>
                        <input id="csst-cpanel-username" class="csst-api-input" type="text" value="<?php echo esc_attr($csst_cpanel_username); ?>" autocomplete="off">
                    </div>
                    <div class="csst-api-field" style="flex:1;min-width:220px">
                        <label for="csst-cpanel-token"><?php echo esc_html__('API Token', 'controll-server-connection-speed-test'); ?></label>
                        <input id="csst-cpanel-token" class="csst-api-input" type="password" placeholder="<?php echo $csst_cpanel_has_token ? esc_attr__('Saved — leave blank to keep it', 'controll-server-connection-speed-test') : esc_attr__('Paste token from cPanel > Manage API Tokens', 'controll-server-connection-speed-test'); ?>" autocomplete="off">
                    </div>
                    <div class="csst-api-field" style="flex:1;min-width:220px">
                        <label for="csst-cpanel-host"><?php echo esc_html__('Host', 'controll-server-connection-speed-test'); ?></label>
                        <input id="csst-cpanel-host" class="csst-api-input" type="text" value="<?php echo esc_attr($csst_cpanel_host); ?>" placeholder="server.yourhost.co.za:2083" autocomplete="off">
                    </div>
                </div>
                <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                    <button type="button" id="csst-save-cpanel" class="button button-secondary"><?php echo esc_html__('Save', 'controll-server-connection-speed-test'); ?></button>
                    <button type="button" id="csst-test-cpanel" class="button button-secondary"><?php echo esc_html__('Test Connection', 'controll-server-connection-speed-test'); ?></button>
                    <button type="button" id="csst-clear-cpanel" class="button button-secondary" <?php echo $csst_cpanel_configured ? '' : 'disabled'; ?>><?php echo esc_html__('Disconnect', 'controll-server-connection-speed-test'); ?></button>
                    <span id="csst-cpanel-status" class="csst-status"><?php echo $csst_cpanel_configured
                        ? esc_html__('Connected. Disk Space and the Disk metric now reflect your cPanel quota.', 'controll-server-connection-speed-test')
                        : esc_html__('Not connected — Disk Space currently reports total server filesystem.', 'controll-server-connection-speed-test'); ?></span>
                </div>
            </section>

            <?php
            $csst_api_key = self::get_api_key();
            $csst_has_api_key = $csst_api_key !== '';
            $csst_endpoint_url = rest_url(self::REST_NAMESPACE . '/stats');
            ?>
            <section class="csst-panel">
                <div class="csst-panel-header">
                    <h3><?php echo esc_html__('Remote Monitoring API', 'controll-server-connection-speed-test'); ?></h3>
                    <div style="display:flex;gap:8px">
                        <button id="csst-generate-api-key" class="button button-secondary">
                            <?php echo $csst_has_api_key
                                ? esc_html__('Regenerate Key', 'controll-server-connection-speed-test')
                                : esc_html__('Generate Key', 'controll-server-connection-speed-test'); ?>
                        </button>
                        <button id="csst-revoke-api-key" class="button button-secondary" <?php echo $csst_has_api_key ? '' : 'disabled'; ?>>
                            <?php echo esc_html__('Revoke', 'controll-server-connection-speed-test'); ?>
                        </button>
                    </div>
                </div>
                <p class="description">
                    <?php echo esc_html__('Lets a central monitoring dashboard (e.g. Controll Server Monitor) pull this site\'s diagnostics, live CPU/memory, and disk alert status on demand. Nothing is pushed or streamed continuously — data is only returned when a request carrying the API key below hits the endpoint.', 'controll-server-connection-speed-test'); ?>
                </p>
                <div class="csst-api-field">
                    <label for="csst-api-endpoint"><?php echo esc_html__('Endpoint URL', 'controll-server-connection-speed-test'); ?></label>
                    <div class="csst-api-row">
                        <input id="csst-api-endpoint" class="csst-api-input" type="text" readonly value="<?php echo esc_attr($csst_endpoint_url); ?>">
                        <button type="button" class="button button-secondary csst-copy-btn" data-copy-target="csst-api-endpoint"><?php echo esc_html__('Copy', 'controll-server-connection-speed-test'); ?></button>
                    </div>
                </div>
                <div class="csst-api-field">
                    <label for="csst-api-key"><?php echo esc_html__('API Key', 'controll-server-connection-speed-test'); ?></label>
                    <div class="csst-api-row">
                        <input id="csst-api-key" class="csst-api-input" type="password" readonly value="<?php echo esc_attr($csst_api_key); ?>" placeholder="<?php echo esc_attr__('No key generated yet', 'controll-server-connection-speed-test'); ?>">
                        <button type="button" class="button button-secondary csst-toggle-visibility-btn" data-target="csst-api-key"><?php echo esc_html__('Show', 'controll-server-connection-speed-test'); ?></button>
                        <button type="button" class="button button-secondary csst-copy-btn" data-copy-target="csst-api-key"><?php echo esc_html__('Copy', 'controll-server-connection-speed-test'); ?></button>
                    </div>
                </div>
                <div id="csst-api-key-status" class="csst-status"><?php echo esc_html__('Send this key as the X-CSST-Api-Key request header. Regenerating immediately invalidates the old key.', 'controll-server-connection-speed-test'); ?></div>
            </section>

            </div>

            <div id="csst-view-processes" class="csst-tab-view csst-hidden" aria-hidden="true">
                <section class="csst-panel">
                    <div class="csst-panel-header">
                        <h3><?php echo esc_html__('Server Process Monitor', 'controll-server-connection-speed-test'); ?></h3>
                        <button id="csst-refresh-processes" class="button button-secondary">
                            <?php echo esc_html__('Refresh Processes', 'controll-server-connection-speed-test'); ?>
                        </button>
                    </div>
                    <p class="description">
                        <?php echo esc_html__('Shows top running processes sorted by CPU usage. Availability depends on hosting permissions.', 'controll-server-connection-speed-test'); ?>
                    </p>
                    <div id="csst-processes-status" class="csst-status"><?php echo esc_html__('Process list not loaded yet.', 'controll-server-connection-speed-test'); ?></div>
                    <div class="csst-table-wrap">
                        <table class="csst-table">
                            <thead>
                                <tr>
                                    <th><?php echo esc_html__('PID', 'controll-server-connection-speed-test'); ?></th>
                                    <th><?php echo esc_html__('User', 'controll-server-connection-speed-test'); ?></th>
                                    <th><?php echo esc_html__('CPU %', 'controll-server-connection-speed-test'); ?></th>
                                    <th><?php echo esc_html__('MEM %', 'controll-server-connection-speed-test'); ?></th>
                                    <th><?php echo esc_html__('Elapsed', 'controll-server-connection-speed-test'); ?></th>
                                    <th><?php echo esc_html__('Command', 'controll-server-connection-speed-test'); ?></th>
                                </tr>
                            </thead>
                            <tbody id="csst-processes-body">
                                <tr>
                                    <td colspan="6"><?php echo esc_html__('No process data yet.', 'controll-server-connection-speed-test'); ?></td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </section>
            </div>
        </div>
        <?php
    }

    private static function get_history(): array {
        $history = get_option(self::HISTORY_OPTION, []);

        if (!is_array($history)) {
            return [];
        }

        return array_values(array_filter($history, static function ($entry): bool {
            return is_array($entry)
                && isset($entry['timestamp'])
                && isset($entry['latencyMs'])
                && isset($entry['jitterMs'])
                && isset($entry['downloadMbps'])
                && isset($entry['uploadMbps']);
        }));
    }

    private static function get_diagnostics_history(): array {
        $history = get_option(self::DIAGNOSTICS_HISTORY_OPTION, []);

        if (!is_array($history)) {
            return [];
        }

        return array_values(array_filter($history, static function ($entry): bool {
            return is_array($entry) && isset($entry['timestamp']) && isset($entry['activePluginCount']);
        }));
    }

    private static function parse_ini_size_to_bytes(string $value): ?int {
        $trimmed = trim($value);
        if ($trimmed === '') {
            return null;
        }

        if (is_numeric($trimmed)) {
            return (int) $trimmed;
        }

        if (!preg_match('/^(\d+(?:\.\d+)?)\s*([kmgt]?)$/i', $trimmed, $matches)) {
            return null;
        }

        $number = (float) $matches[1];
        $unit = strtolower($matches[2]);
        $multiplier = 1;

        if ($unit === 'k') {
            $multiplier = 1024;
        } elseif ($unit === 'm') {
            $multiplier = 1024 * 1024;
        } elseif ($unit === 'g') {
            $multiplier = 1024 * 1024 * 1024;
        } elseif ($unit === 't') {
            $multiplier = 1024 * 1024 * 1024 * 1024;
        }

        return (int) round($number * $multiplier);
    }

    private static function detect_cpu_count(): ?int {
        $from_env = getenv('NUMBER_OF_PROCESSORS');
        if (is_string($from_env) && ctype_digit($from_env) && (int) $from_env > 0) {
            return (int) $from_env;
        }

        if (is_readable('/proc/cpuinfo')) {
            $cpuinfo = @file_get_contents('/proc/cpuinfo');
            if (is_string($cpuinfo) && $cpuinfo !== '') {
                preg_match_all('/^processor\s*:/m', $cpuinfo, $matches);
                $count = isset($matches[0]) ? count($matches[0]) : 0;
                if ($count > 0) {
                    return $count;
                }
            }
        }

        if (function_exists('shell_exec')) {
            $nproc = @shell_exec('nproc 2>/dev/null');
            if (is_string($nproc)) {
                $nproc = trim($nproc);
                if (ctype_digit($nproc) && (int) $nproc > 0) {
                    return (int) $nproc;
                }
            }
        }

        return null;
    }

    private static function detect_total_ram_bytes(): ?int {
        if (is_readable('/proc/meminfo')) {
            $meminfo = @file_get_contents('/proc/meminfo');
            if (is_string($meminfo) && preg_match('/^MemTotal:\s*(\d+)\s*kB$/mi', $meminfo, $matches)) {
                return (int) $matches[1] * 1024;
            }
        }

        if (function_exists('shell_exec')) {
            $line = @shell_exec("awk '/MemTotal/ {print $2}' /proc/meminfo 2>/dev/null");
            if (is_string($line)) {
                $line = trim($line);
                if (ctype_digit($line)) {
                    return (int) $line * 1024;
                }
            }
        }

        return null;
    }

    private static function compute_live_stats(): array {
        $lve = self::get_cpanel_lve_usage_cached();
        $lve_available = !isset($lve['error']);

        $load = function_exists('sys_getloadavg') ? sys_getloadavg() : null;
        $cpu_count = self::detect_cpu_count();
        $system_cpu_percent = null;
        if (is_array($load) && $cpu_count && $cpu_count > 0) {
            $system_cpu_percent = min(100.0, round(((float) $load[0] / $cpu_count) * 100, 1));
        }

        if ($lve_available && isset($lve['cpuPercent'])) {
            $cpu_percent = $lve['cpuPercent'];
            $cpu_source = 'cpanel-lve';
            $cpu_used_raw = $lve['cpuUsedCores'];
            $cpu_max_raw = $lve['cpuMaxCores'];
        } else {
            $cpu_percent = $system_cpu_percent;
            $cpu_source = 'system';
            $cpu_used_raw = is_array($load) ? round((float) $load[0], 2) : null;
            $cpu_max_raw = $cpu_count;
        }

        if ($lve_available && isset($lve['memPercent'])) {
            $memory_percent = $lve['memPercent'];
            $memory_source = 'cpanel-lve';
            $used_ram = $lve['memUsedBytes'];
            $total_ram_out = $lve['memTotalBytes'];
        } else {
            // No cPanel/LVE account-level figure available (not CloudLinux, or
            // shell_exec disabled). Rather than falling back to the whole
            // physical server's /proc/meminfo — which conflates this site with
            // every other account sharing the box — fall back to this specific
            // WordPress installation's own PHP memory usage against its
            // configured memory_limit.
            $php_memory_used = memory_get_usage(true);
            $php_memory_limit_bytes = self::parse_ini_size_to_bytes((string) ini_get('memory_limit'));

            $memory_percent = null;
            if ($php_memory_limit_bytes !== null && $php_memory_limit_bytes > 0) {
                $memory_percent = round(($php_memory_used / $php_memory_limit_bytes) * 100, 1);
            }
            $memory_source = 'php-process';
            $used_ram = $php_memory_used;
            $total_ram_out = ($php_memory_limit_bytes !== null && $php_memory_limit_bytes > 0) ? $php_memory_limit_bytes : null;
        }

        return [
            'timestamp' => current_time('mysql'),
            'cpuPercent' => $cpu_percent,
            'cpuSource' => $cpu_source,
            // Both expressed in core-equivalents regardless of source, so
            // consumers can format them identically: when cpuSource is "system",
            // cpuUsedRaw is the 1-minute load average and cpuMaxRaw is the
            // logical core count; when "cpanel-lve", both are converted from
            // CloudLinux's percent-of-one-core CPU quota units (100 = 1 core).
            'cpuUsedRaw' => $cpu_used_raw,
            'cpuMaxRaw' => $cpu_max_raw,
            'memoryPercent' => $memory_percent,
            'memorySource' => $memory_source,
            'totalRamBytes' => $total_ram_out,
            'usedRamBytes' => $used_ram,
            'phpMemoryBytes' => memory_get_usage(true),
        ];
    }

    public static function ajax_live_stats(): void {
        self::verify_request();

        wp_send_json_success(self::compute_live_stats());
    }

    private static function score_to_label(int $score): string {
        if ($score <= 1) {
            return 'good';
        }
        if ($score === 2) {
            return 'watch';
        }
        return 'needs-attention';
    }

    private static function cpanel_configured(): bool {
        $username = (string) get_option(self::CPANEL_USERNAME_OPTION, '');
        $token = (string) get_option(self::CPANEL_API_TOKEN_OPTION, '');
        $host = (string) get_option(self::CPANEL_HOST_OPTION, '');

        return $username !== '' && $token !== '' && $host !== '';
    }

    private static function build_cpanel_url(string $host, string $path): string {
        $host = trim($host);
        if (!preg_match('#^https?://#i', $host)) {
            $host = 'https://' . $host;
        }

        $parts = wp_parse_url($host);
        $scheme = $parts['scheme'] ?? 'https';
        $hostname = $parts['host'] ?? $host;
        $port = $parts['port'] ?? 2083;

        return $scheme . '://' . $hostname . ':' . $port . $path;
    }

    /**
     * Calls cPanel's UAPI Quota::get_quota_info to get the account's real
     * hosting-package disk allocation, since disk_free_space()/disk_total_space()
     * only ever see the underlying server's full filesystem, not what's actually
     * been allocated to this account on shared hosting.
     *
     * @return array{usedBytes?: int, totalBytes?: int, freeBytes?: int, usedPercent?: float, unlimited?: bool, error?: string}
     */
    private static function fetch_cpanel_quota(string $username, string $token, string $host): array {
        if ($username === '' || $token === '' || $host === '') {
            return ['error' => 'cPanel username, API token, and host are all required.'];
        }

        $url = self::build_cpanel_url($host, '/execute/Quota/get_quota_info');

        $response = wp_remote_get($url, [
            'timeout' => 8,
            'headers' => [
                'Authorization' => 'cpanel ' . $username . ':' . $token,
            ],
        ]);

        if (is_wp_error($response)) {
            return ['error' => $response->get_error_message()];
        }

        $code = (int) wp_remote_retrieve_response_code($response);
        $body = json_decode((string) wp_remote_retrieve_body($response), true);

        if ($code !== 200 || !is_array($body)) {
            return ['error' => 'Unexpected response (HTTP ' . $code . ') from ' . $url];
        }

        if ((int) ($body['status'] ?? 0) !== 1 || !isset($body['data'])) {
            $message = isset($body['errors']) ? implode('; ', (array) $body['errors']) : 'cPanel API returned an error.';
            return ['error' => $message];
        }

        $data = $body['data'];
        $used_mb = isset($data['megabytes_used']) ? (float) $data['megabytes_used'] : null;
        $limit_mb = isset($data['megabyte_limit']) ? (float) $data['megabyte_limit'] : null;

        if ($used_mb === null || $limit_mb === null) {
            return ['error' => 'Unexpected response shape from cPanel Quota::get_quota_info.'];
        }

        if ($limit_mb <= 0.0) {
            // cPanel reports 0 as "unlimited" — no quota to calculate a percentage against.
            return ['unlimited' => true, 'usedBytes' => (int) round($used_mb * 1024 * 1024)];
        }

        return [
            'usedBytes' => (int) round($used_mb * 1024 * 1024),
            'totalBytes' => (int) round($limit_mb * 1024 * 1024),
            'freeBytes' => (int) round(max(0.0, $limit_mb - $used_mb) * 1024 * 1024),
            'usedPercent' => round(($used_mb / $limit_mb) * 100, 2),
        ];
    }

    private static function shell_exec_available(): bool {
        if (!function_exists('shell_exec')) {
            return false;
        }
        $disabled = array_map('trim', explode(',', (string) ini_get('disable_functions')));
        return !in_array('shell_exec', $disabled, true);
    }

    /**
     * Calls the local `uapi` binary directly (same mechanism cPanel's own web UI
     * uses internally) instead of going over HTTP. Only works when the plugin is
     * installed on the same account it's monitoring — which is the normal case —
     * and needs no stored credentials at all, since it just runs as the account's
     * own already-authenticated OS user. Falls back to the HTTP-based
     * fetch_cpanel_quota() (manual username/token/host) when unavailable, e.g. on
     * hosts that disable shell_exec.
     *
     * @return array{usedBytes?: int, totalBytes?: int, freeBytes?: int, usedPercent?: float, unlimited?: bool, error?: string}
     */
    private static function fetch_cpanel_quota_via_shell(): array {
        if (!self::shell_exec_available()) {
            return ['error' => 'shell_exec is disabled on this host.'];
        }

        $output = shell_exec('uapi --output=json Quota get_quota_info 2>&1');
        if ($output === null || trim((string) $output) === '') {
            return ['error' => 'No output from the uapi command — it may not be installed on this host.'];
        }

        $decoded = json_decode(trim((string) $output), true);
        if (!is_array($decoded) || !isset($decoded['result']['data'])) {
            return ['error' => 'Unexpected output from uapi: ' . substr(trim((string) $output), 0, 200)];
        }

        if ((int) ($decoded['result']['status'] ?? 0) !== 1) {
            $errors = $decoded['result']['errors'] ?? null;
            $message = is_array($errors) ? implode('; ', $errors) : 'uapi reported an error.';
            return ['error' => $message];
        }

        $data = $decoded['result']['data'];
        $used_mb = isset($data['megabytes_used']) ? (float) $data['megabytes_used'] : null;
        $limit_mb = isset($data['megabyte_limit']) ? (float) $data['megabyte_limit'] : null;

        if ($used_mb === null || $limit_mb === null) {
            return ['error' => 'Unexpected uapi response shape.'];
        }

        if ($limit_mb <= 0.0) {
            return ['unlimited' => true, 'usedBytes' => (int) round($used_mb * 1024 * 1024)];
        }

        return [
            'usedBytes' => (int) round($used_mb * 1024 * 1024),
            'totalBytes' => (int) round($limit_mb * 1024 * 1024),
            'freeBytes' => (int) round(max(0.0, $limit_mb - $used_mb) * 1024 * 1024),
            'usedPercent' => round(($used_mb / $limit_mb) * 100, 2),
        ];
    }

    public static function refresh_cpanel_shell_quota_cache(): void {
        $result = self::fetch_cpanel_quota_via_shell();
        $result['checkedAt'] = current_time('mysql');
        update_option(self::CPANEL_SHELL_QUOTA_CACHE_OPTION, $result, false);
    }

    /**
     * Reads the cron-refreshed cache so the (relatively slow, subprocess-spawning)
     * uapi call never runs on the hot path of a diagnostics/REST request — this
     * matters now that the companion Controll Server Monitor dashboard can poll
     * every couple of seconds. Populates the cache once synchronously on first
     * use (e.g. right after activation, before the first cron tick) so the
     * feature works immediately instead of waiting up to an hour.
     */
    private static function get_cpanel_shell_quota_cached(): array {
        $cache = get_option(self::CPANEL_SHELL_QUOTA_CACHE_OPTION, null);
        if (is_array($cache)) {
            return $cache;
        }

        $result = self::fetch_cpanel_quota_via_shell();
        $result['checkedAt'] = current_time('mysql');
        update_option(self::CPANEL_SHELL_QUOTA_CACHE_OPTION, $result, false);

        return $result;
    }

    /**
     * On CloudLinux/LVE shared hosting, sys_getloadavg() and /proc/meminfo report
     * the *entire physical server's* CPU/memory, not this account's actual LVE
     * container limits — the same class of problem the disk quota feature solves,
     * just for CPU/RAM. cPanel's own account-level "Resource Usage" page is
     * powered by UAPI ResourceUsage::get_usages, which includes CloudLinux's
     * `lvecpu` (CPU %, already expressed against the account's own cap) and
     * `lvememphy` (physical memory bytes, against the account's own cap) entries
     * when present — exactly the account-scoped numbers we want.
     *
     * @return array{cpuPercent?: float, cpuUsed?: float, cpuMax?: float, memUsedBytes?: int, memTotalBytes?: int, memPercent?: float, error?: string}
     */
    private static function fetch_cpanel_lve_usage_via_shell(): array {
        if (!self::shell_exec_available()) {
            return ['error' => 'shell_exec is disabled on this host.'];
        }

        $output = shell_exec('uapi --output=json ResourceUsage get_usages 2>&1');
        if ($output === null || trim((string) $output) === '') {
            return ['error' => 'No output from the uapi command — it may not be installed on this host.'];
        }

        $decoded = json_decode(trim((string) $output), true);
        if (!is_array($decoded) || !isset($decoded['result']['data']) || !is_array($decoded['result']['data'])) {
            return ['error' => 'Unexpected output from uapi: ' . substr(trim((string) $output), 0, 200)];
        }

        if ((int) ($decoded['result']['status'] ?? 0) !== 1) {
            $errors = $decoded['result']['errors'] ?? null;
            $message = is_array($errors) ? implode('; ', $errors) : 'uapi reported an error.';
            return ['error' => $message];
        }

        $byId = [];
        foreach ($decoded['result']['data'] as $item) {
            if (is_array($item) && isset($item['id'])) {
                $byId[$item['id']] = $item;
            }
        }

        if (!isset($byId['lvecpu']) || !isset($byId['lvememphy'])) {
            // Not a CloudLinux/LVE-backed account — nothing account-scoped to report.
            return ['error' => 'This host does not expose CloudLinux LVE resource limits.'];
        }

        $cpu_used = isset($byId['lvecpu']['usage']) ? (float) $byId['lvecpu']['usage'] : null;
        $cpu_max = isset($byId['lvecpu']['maximum']) ? (float) $byId['lvecpu']['maximum'] : null;
        $mem_used = isset($byId['lvememphy']['usage']) ? (float) $byId['lvememphy']['usage'] : null;
        $mem_max = isset($byId['lvememphy']['maximum']) ? (float) $byId['lvememphy']['maximum'] : null;

        if ($cpu_used === null || $cpu_max === null || $mem_used === null || $mem_max === null) {
            return ['error' => 'Unexpected uapi ResourceUsage response shape.'];
        }

        $result = [
            'memUsedBytes' => (int) round($mem_used),
            'memTotalBytes' => (int) round($mem_max),
        ];

        if ($cpu_max > 0) {
            $result['cpuPercent'] = round(min(100.0, ($cpu_used / $cpu_max) * 100), 1);
            // CloudLinux expresses its CPU ("SPEED") limit as a percentage of one
            // physical core — 100 = 1 core, 200 = 2 cores — so dividing by 100
            // converts the raw uapi units into an actual core-equivalent count.
            $result['cpuUsedCores'] = round($cpu_used / 100, 2);
            $result['cpuMaxCores'] = round($cpu_max / 100, 2);
        }
        if ($mem_max > 0) {
            $result['memPercent'] = round(min(100.0, ($mem_used / $mem_max) * 100), 1);
        }

        return $result;
    }

    /**
     * Short-lived transient cache (not the hourly cron cache used for disk quota)
     * since CPU/memory are meant to be "live" — the companion dashboard's charts
     * would go stale for an hour otherwise. Still avoids spawning a uapi
     * subprocess on every single 2-second poll.
     */
    private static function get_cpanel_lve_usage_cached(): array {
        $cached = get_transient(self::CPANEL_LVE_USAGE_TRANSIENT);
        if (is_array($cached)) {
            return $cached;
        }

        $result = self::fetch_cpanel_lve_usage_via_shell();
        set_transient(self::CPANEL_LVE_USAGE_TRANSIENT, $result, 10);

        return $result;
    }

    /**
     * @return array{freeBytes: ?int, totalBytes: ?int, usedPercent: ?float, source: string, sourceError: ?string}
     */
    private static function get_disk_usage(): array {
        $shell = self::get_cpanel_shell_quota_cached();
        if (!isset($shell['error']) && !($shell['unlimited'] ?? false)) {
            return [
                'freeBytes' => $shell['freeBytes'],
                'totalBytes' => $shell['totalBytes'],
                'usedPercent' => $shell['usedPercent'],
                'source' => 'cpanel-shell',
                'sourceError' => null,
            ];
        }

        if (self::cpanel_configured()) {
            $cpanel = self::fetch_cpanel_quota(
                (string) get_option(self::CPANEL_USERNAME_OPTION, ''),
                (string) get_option(self::CPANEL_API_TOKEN_OPTION, ''),
                (string) get_option(self::CPANEL_HOST_OPTION, '')
            );

            if (!isset($cpanel['error']) && !($cpanel['unlimited'] ?? false)) {
                return [
                    'freeBytes' => $cpanel['freeBytes'],
                    'totalBytes' => $cpanel['totalBytes'],
                    'usedPercent' => $cpanel['usedPercent'],
                    'source' => 'cpanel',
                    'sourceError' => null,
                ];
            }

            $cpanel_error = $cpanel['error'] ?? 'cPanel reports an unlimited quota for this account — nothing to calculate a percentage against.';
        } else {
            $cpanel_error = $shell['error'] ?? null;
        }

        $disk_free = @disk_free_space(ABSPATH);
        $disk_total = @disk_total_space(ABSPATH);

        $free_bytes = is_numeric($disk_free) ? (int) $disk_free : null;
        $total_bytes = is_numeric($disk_total) ? (int) $disk_total : null;

        $used_percent = null;
        if ($free_bytes !== null && $total_bytes !== null && $total_bytes > 0) {
            $used_percent = round((($total_bytes - $free_bytes) / $total_bytes) * 100, 2);
        }

        return [
            'freeBytes' => $free_bytes,
            'totalBytes' => $total_bytes,
            'usedPercent' => $used_percent,
            'source' => 'filesystem',
            'sourceError' => $cpanel_error,
        ];
    }

    /**
     * @return array{score: int, rating: string, summary: string}
     */
    private static function disk_rating_for_percent(?float $percent): array {
        if ($percent === null) {
            return [
                'score' => 1,
                'rating' => 'unknown',
                'summary' => 'Disk usage could not be determined on this host.',
            ];
        }

        if ($percent >= self::DISK_ALERT_THRESHOLD_PERCENT) {
            return [
                'score' => 3,
                'rating' => 'needs-attention',
                'summary' => sprintf('Disk usage is critical at %.2f%% (alert threshold is %.0f%%).', $percent, self::DISK_ALERT_THRESHOLD_PERCENT),
            ];
        }

        if ($percent >= 80.0) {
            return [
                'score' => 2,
                'rating' => 'watch',
                'summary' => sprintf('Disk usage is elevated at %.2f%%.', $percent),
            ];
        }

        return [
            'score' => 1,
            'rating' => 'good',
            'summary' => sprintf('Disk usage is healthy at %.2f%%.', $percent),
        ];
    }

    public static function run_disk_monitor_check(): void {
        $usage = self::get_disk_usage();
        $percent = $usage['usedPercent'];
        $now = current_time('mysql');

        $status = get_option(self::DISK_MONITOR_STATUS_OPTION, []);
        if (!is_array($status)) {
            $status = [];
        }

        $alert_active = $percent !== null && $percent >= self::DISK_ALERT_THRESHOLD_PERCENT;
        $alert_count = isset($status['alertCount']) ? (int) $status['alertCount'] : 0;
        $last_alert_at = $status['lastAlertAt'] ?? null;

        if ($alert_active) {
            $sent = self::send_disk_alert_email($percent, $usage);
            if ($sent) {
                $alert_count++;
                $last_alert_at = $now;
            }
        } else {
            $alert_count = 0;
        }

        update_option(self::DISK_MONITOR_STATUS_OPTION, [
            'checkedAt' => $now,
            'freeBytes' => $usage['freeBytes'],
            'totalBytes' => $usage['totalBytes'],
            'usedPercent' => $percent,
            'alertActive' => $alert_active,
            'alertCount' => $alert_count,
            'lastAlertAt' => $last_alert_at,
        ], false);
    }

    private static function send_disk_alert_email(float $percent, array $usage): bool {
        $to = get_option('admin_email');
        if (!is_string($to) || $to === '') {
            return false;
        }

        $site_name = get_bloginfo('name');
        $admin_url = admin_url('admin.php?page=' . self::SLUG);
        $free_gb = $usage['freeBytes'] !== null ? round($usage['freeBytes'] / 1073741824, 2) : null;
        $total_gb = $usage['totalBytes'] !== null ? round($usage['totalBytes'] / 1073741824, 2) : null;

        $subject = sprintf('[%s] Disk space alert: %.2f%% used', $site_name, $percent);

        $body_lines = [
            sprintf('Disk usage on %s has reached %.2f%%, at or above the %.0f%% alert threshold.', home_url(), $percent, self::DISK_ALERT_THRESHOLD_PERCENT),
            '',
            $free_gb !== null && $total_gb !== null
                ? sprintf('Free space: %.2f GB of %.2f GB total.', $free_gb, $total_gb)
                : 'Free/total space could not be fully determined.',
            '',
            'This check runs hourly and will keep emailing every hour while usage stays at or above the threshold.',
            '',
            sprintf('Review: %s', $admin_url),
        ];

        return (bool) wp_mail($to, $subject, implode("\n", $body_lines));
    }

    private static function verify_request(): void {
        if (!current_user_can('manage_options')) {
            wp_send_json_error(['message' => 'Forbidden'], 403);
        }

        check_ajax_referer(self::NONCE_ACTION, 'nonce');
    }

    public static function ajax_ping(): void {
        self::verify_request();

        wp_send_json_success([
            'serverTime' => microtime(true),
        ]);
    }

    public static function ajax_download(): void {
        self::verify_request();

        $size = isset($_POST['size']) ? (int) $_POST['size'] : 1000000;
        $size = max(65536, min($size, 10000000));

        if (function_exists('apache_setenv')) {
            @apache_setenv('no-gzip', '1');
        }
        @ini_set('zlib.output_compression', '0');

        nocache_headers();
        header('Content-Type: application/octet-stream');
        header('Content-Length: ' . $size);
        header('Content-Encoding: identity');
        header('X-Accel-Buffering: no');

        $remaining = $size;
        $chunk_size = 262144;

        while ($remaining > 0) {
            $current = min($remaining, $chunk_size);
            echo random_bytes($current);
            $remaining -= $current;

            if (ob_get_level() > 0) {
                @ob_flush();
            }
            flush();
        }

        wp_die();
    }

    public static function ajax_upload(): void {
        self::verify_request();

        if (!isset($_FILES['payload'])) {
            wp_send_json_error(['message' => 'No payload provided'], 400);
        }

        if ((int) $_FILES['payload']['error'] !== UPLOAD_ERR_OK) {
            wp_send_json_error(['message' => 'Upload failed'], 400);
        }

        $bytes_received = (int) $_FILES['payload']['size'];

        wp_send_json_success([
            'bytesReceived' => $bytes_received,
            'serverTime' => microtime(true),
        ]);
    }

    public static function ajax_history_add(): void {
        self::verify_request();

        $latency_ms = isset($_POST['latencyMs']) ? (float) $_POST['latencyMs'] : 0.0;
        $jitter_ms = isset($_POST['jitterMs']) ? (float) $_POST['jitterMs'] : 0.0;
        $download_mbps = isset($_POST['downloadMbps']) ? (float) $_POST['downloadMbps'] : 0.0;
        $upload_mbps = isset($_POST['uploadMbps']) ? (float) $_POST['uploadMbps'] : 0.0;
        $packet_loss_pct = isset($_POST['packetLossPct']) ? (float) $_POST['packetLossPct'] : 0.0;
        $latency_p50_ms = isset($_POST['latencyP50Ms']) ? (float) $_POST['latencyP50Ms'] : 0.0;
        $latency_p95_ms = isset($_POST['latencyP95Ms']) ? (float) $_POST['latencyP95Ms'] : 0.0;
        $quality_grade = isset($_POST['qualityGrade']) ? sanitize_text_field(wp_unslash($_POST['qualityGrade'])) : '';
        $ping_samples = isset($_POST['pingSamples']) ? sanitize_text_field(wp_unslash($_POST['pingSamples'])) : '';
        $client_info = isset($_POST['clientInfo']) ? sanitize_text_field(wp_unslash($_POST['clientInfo'])) : '';

        $record = [
            'id' => wp_generate_uuid4(),
            'timestamp' => current_time('mysql'),
            'latencyMs' => round($latency_ms, 1),
            'jitterMs' => round($jitter_ms, 1),
            'packetLossPct' => round($packet_loss_pct, 1),
            'latencyP50Ms' => round($latency_p50_ms, 1),
            'latencyP95Ms' => round($latency_p95_ms, 1),
            'downloadMbps' => round($download_mbps, 2),
            'uploadMbps' => round($upload_mbps, 2),
            'qualityGrade' => $quality_grade,
            'pingSamples' => $ping_samples,
            'clientInfo' => $client_info,
            'siteUrl' => home_url(),
        ];

        $history = self::get_history();
        array_unshift($history, $record);
        $history = array_slice($history, 0, self::MAX_HISTORY_ITEMS);

        update_option(self::HISTORY_OPTION, $history, false);

        wp_send_json_success([
            'history' => $history,
        ]);
    }

    public static function ajax_history_list(): void {
        self::verify_request();

        wp_send_json_success([
            'history' => self::get_history(),
        ]);
    }

    public static function ajax_diagnostics_history_list(): void {
        self::verify_request();

        wp_send_json_success([
            'history' => self::get_diagnostics_history(),
        ]);
    }

    private static function compute_diagnostics(): array {
        global $wpdb;

        $db_start = microtime(true);
        $wpdb->get_var('SELECT 1');
        $db_ms = (microtime(true) - $db_start) * 1000;

        $cpu_start = microtime(true);
        $value = 0;
        for ($i = 0; $i < 300000; $i++) {
            $value += ($i % 7) * ($i % 5);
        }
        $cpu_ms = (microtime(true) - $cpu_start) * 1000;

        $load = function_exists('sys_getloadavg') ? sys_getloadavg() : null;
        $cpu_count = self::detect_cpu_count();
        $total_ram_bytes = self::detect_total_ram_bytes();
        $memory_limit_raw = (string) ini_get('memory_limit');
        $memory_limit_bytes = self::parse_ini_size_to_bytes($memory_limit_raw);

        $db_score = $db_ms <= 5 ? 1 : ($db_ms <= 20 ? 2 : 3);
        $php_score = $cpu_ms <= 15 ? 1 : ($cpu_ms <= 50 ? 2 : 3);

        $load_ratio = null;
        $load_score = 1;
        if (is_array($load) && $cpu_count && $cpu_count > 0) {
            $load_ratio = (float) $load[0] / $cpu_count;
            if ($load_ratio <= 0.7) {
                $load_score = 1;
            } elseif ($load_ratio <= 1.0) {
                $load_score = 2;
            } elseif ($load_ratio <= 1.5) {
                $load_score = 3;
            } else {
                $load_score = 4;
            }
        }

        $memory_score = 1;
        $memory_limit_ratio = null;
        if ($memory_limit_bytes && $total_ram_bytes && $total_ram_bytes > 0) {
            $memory_limit_ratio = (float) $memory_limit_bytes / $total_ram_bytes;
            if ($memory_limit_ratio <= 0.2) {
                $memory_score = 1;
            } elseif ($memory_limit_ratio <= 0.5) {
                $memory_score = 2;
            } else {
                $memory_score = 3;
            }
        }

        $disk_usage = self::get_disk_usage();
        $disk_rating = self::disk_rating_for_percent($disk_usage['usedPercent']);
        $disk_score = $disk_rating['score'];

        if ($disk_usage['source'] === 'cpanel-shell') {
            $disk_rating['summary'] .= ' Reflects your cPanel account quota (auto-detected), not total server disk.';
        } elseif ($disk_usage['source'] === 'cpanel') {
            $disk_rating['summary'] .= ' Reflects your cPanel account quota, not total server disk.';
        } elseif (!empty($disk_usage['sourceError'])) {
            $disk_rating['summary'] .= ' cPanel quota lookup failed (' . $disk_usage['sourceError'] . '); showing total server disk instead.';
        }

        $overall_score = max($db_score, $php_score, $load_score, $memory_score, $disk_score);

        $active_plugin_count = count((array) get_option('active_plugins', []));
        if (is_multisite()) {
            $network_active = get_site_option('active_sitewide_plugins', []);
            $active_plugin_count += is_array($network_active) ? count($network_active) : 0;
        }

        $query_count = null;
        $query_total_ms = null;
        if (defined('SAVEQUERIES') && SAVEQUERIES && !empty($wpdb->queries) && is_array($wpdb->queries)) {
            $query_count = count($wpdb->queries);
            $query_total_ms = round(array_sum(array_column($wpdb->queries, 1)) * 1000, 2);
        }

        $peak_memory_bytes = memory_get_peak_usage(true);

        $data = [
            'timestamp' => current_time('mysql'),
            'siteUrl' => home_url(),
            'pluginVersion' => CSST_PLUGIN_VERSION,
            'phpVersion' => PHP_VERSION,
            'wpVersion' => get_bloginfo('version'),
            'cpuLogicalCores' => $cpu_count,
            'totalSystemRamBytes' => $total_ram_bytes,
            'dbQueryMs' => round($db_ms, 2),
            'phpBenchmarkMs' => round($cpu_ms, 2),
            'benchmarkCheck' => $value,
            'memoryLimit' => $memory_limit_raw,
            'maxExecutionTime' => ini_get('max_execution_time'),
            'loadAverage' => is_array($load)
                ? [
                    '1min' => round((float) $load[0], 2),
                    '5min' => round((float) $load[1], 2),
                    '15min' => round((float) $load[2], 2),
                ]
                : null,
            'disk' => [
                'freeBytes' => $disk_usage['freeBytes'],
                'totalBytes' => $disk_usage['totalBytes'],
                'usedPercent' => $disk_usage['usedPercent'],
                'source' => $disk_usage['source'],
            ],
            'diskMonitor' => self::get_disk_monitor_status(),
            'duplicatorBackup' => self::get_duplicator_backup_status(),
            'activePluginCount' => $active_plugin_count,
            'queryCount' => $query_count,
            'queryTotalMs' => $query_total_ms,
            'peakMemoryBytes' => $peak_memory_bytes,
            'interpretation' => [
                'overall' => [
                    'rating' => self::score_to_label($overall_score),
                    'summary' => $overall_score <= 1
                        ? 'Server-side diagnostics look healthy.'
                        : ($overall_score === 2
                            ? 'Server diagnostics are acceptable but should be watched.'
                            : 'One or more server-side metrics need attention.'),
                ],
                'database' => [
                    'rating' => self::score_to_label($db_score),
                    'summary' => $db_score <= 1 ? 'Database response is fast.' : ($db_score === 2 ? 'Database response is moderate.' : 'Database response is slow.'),
                ],
                'phpBenchmark' => [
                    'rating' => self::score_to_label($php_score),
                    'summary' => $php_score <= 1 ? 'PHP execution speed is good.' : ($php_score === 2 ? 'PHP execution speed is fair.' : 'PHP execution speed is slow.'),
                ],
                'load' => [
                    'rating' => self::score_to_label($load_score),
                    'ratio1MinToCpu' => is_null($load_ratio) ? null : round($load_ratio, 2),
                    'summary' => is_null($load_ratio)
                        ? 'Load ratio not available on this host.'
                        : ($load_ratio <= 0.7
                            ? 'Current CPU load is comfortable.'
                            : ($load_ratio <= 1.0
                                ? 'CPU load is moderate.'
                                : 'CPU load is high and may impact response times.')),
                ],
                'memory' => [
                    'rating' => self::score_to_label($memory_score),
                    'memoryLimitToSystemRatio' => is_null($memory_limit_ratio) ? null : round($memory_limit_ratio, 3),
                    'summary' => is_null($memory_limit_ratio)
                        ? 'Memory limit ratio could not be determined.'
                        : ($memory_limit_ratio <= 0.2
                            ? 'Memory allocation is conservative.'
                            : ($memory_limit_ratio <= 0.5
                                ? 'Memory allocation is moderate.'
                                : 'Memory allocation is high compared to detected system RAM.')),
                ],
                'disk' => [
                    'rating' => $disk_rating['rating'],
                    'usedPercent' => $disk_usage['usedPercent'],
                    'summary' => $disk_rating['summary'],
                ],
            ],
        ];

        return $data;
    }

    public static function ajax_server_diagnostics(): void {
        self::verify_request();

        $data = self::compute_diagnostics();

        $diagnostics_record = [
            'timestamp' => $data['timestamp'],
            'activePluginCount' => $data['activePluginCount'],
            'queryCount' => $data['queryCount'],
            'queryTotalMs' => $data['queryTotalMs'],
            'peakMemoryBytes' => $data['peakMemoryBytes'],
            'dbQueryMs' => $data['dbQueryMs'],
            'phpBenchmarkMs' => $data['phpBenchmarkMs'],
            'overallRating' => $data['interpretation']['overall']['rating'],
        ];

        $diagnostics_history = self::get_diagnostics_history();
        array_unshift($diagnostics_history, $diagnostics_record);
        $diagnostics_history = array_slice($diagnostics_history, 0, self::MAX_DIAGNOSTICS_HISTORY_ITEMS);
        update_option(self::DIAGNOSTICS_HISTORY_OPTION, $diagnostics_history, false);

        $data['pluginLoadHistory'] = $diagnostics_history;

        wp_send_json_success($data);
    }

    /**
     * @return array{checkedAt: ?string, usedPercent: ?float, alertActive: bool, alertCount: int, lastAlertAt: ?string}
     */
    private static function get_disk_monitor_status(): array {
        $status = get_option(self::DISK_MONITOR_STATUS_OPTION, []);
        if (!is_array($status)) {
            $status = [];
        }

        return [
            'checkedAt' => isset($status['checkedAt']) ? (string) $status['checkedAt'] : null,
            'usedPercent' => isset($status['usedPercent']) && $status['usedPercent'] !== null ? (float) $status['usedPercent'] : null,
            'alertActive' => !empty($status['alertActive']),
            'alertCount' => isset($status['alertCount']) ? (int) $status['alertCount'] : 0,
            'lastAlertAt' => isset($status['lastAlertAt']) ? (string) $status['lastAlertAt'] : null,
        ];
    }

    /**
     * Reads Duplicator Pro's own `wp_duplicator_backups` table directly rather
     * than calling into its PHP classes, so this keeps working (reporting "not
     * installed") whether Duplicator Pro is active, inactive, or absent —
     * without needing it loaded/autoloadable at the time diagnostics run.
     *
     * Status codes and the relative-time math mirror Duplicator Pro's own
     * (AbstractPackage::STATUS_COMPLETE = 100, negative = failed/cancelled,
     * DupPackage::getPackageLife('human')'s use of human_time_diff()) so the
     * "X ago" wording matches what Duplicator itself reports.
     *
     * @return array{installed: bool, lastBackup: ?array}
     */
    private static function get_duplicator_backup_status(): array {
        global $wpdb;

        $table = $wpdb->base_prefix . 'duplicator_backups';
        $table_exists = $wpdb->get_var($wpdb->prepare('SHOW TABLES LIKE %s', $table)) === $table;

        if (!$table_exists) {
            return ['installed' => false, 'lastBackup' => null];
        }

        // Exclude Duplicator's own temporary/scaffolding rows (flags contains
        // "TEMPORARY"), same as its dbSelect() does by default.
        $row = $wpdb->get_row(
            "SELECT `name`, `status`, `created` FROM `{$table}` " .
            "WHERE FIND_IN_SET('TEMPORARY', `flags`) = 0 " .
            "ORDER BY `id` DESC LIMIT 1"
        );

        if (!$row || (string) $row->created === '' || (string) $row->created === '0000-00-00 00:00:00') {
            return ['installed' => true, 'lastBackup' => null];
        }

        $status = (int) $row->status;
        $is_success = $status === 100;
        $is_failure = $status < 0;
        $is_in_progress = !$is_success && !$is_failure;

        if ($is_success) {
            $status_label = __('Success', 'controll-server-connection-speed-test');
        } elseif ($is_failure) {
            $status_label = __('Failed', 'controll-server-connection-speed-test');
        } else {
            $status_label = __('In progress', 'controll-server-connection-speed-test');
        }

        // created is stored by Duplicator as a GMT string (gmdate()); pairing
        // it with strtotime(gmdate()) for "now" (instead of time()) matches
        // DupPackage::getPackageLife() exactly, so any PHP-timezone quirk in
        // interpreting that string cancels out the same way it does there.
        $created_ts = strtotime((string) $row->created);
        $now_ts = strtotime(gmdate('Y-m-d H:i:s'));

        return [
            'installed' => true,
            'lastBackup' => [
                'name' => (string) $row->name,
                'statusCode' => $status,
                'statusLabel' => $status_label,
                'isSuccess' => $is_success,
                'isFailure' => $is_failure,
                'isInProgress' => $is_in_progress,
                'createdAtGmt' => (string) $row->created,
                'relativeTime' => ($created_ts !== false && $now_ts !== false)
                    ? sprintf(
                        /* translators: %s: human-readable time difference, e.g. "5 hours" */
                        __('%s ago', 'controll-server-connection-speed-test'),
                        human_time_diff($created_ts, $now_ts)
                    )
                    : null,
            ],
        ];
    }

    /**
     * Renders the inner HTML of the Duplicator Pro card, shared between the
     * server-rendered initial page load and (mirrored in JS) the update that
     * runs after "Run Diagnostics" completes.
     *
     * @param array{installed: bool, lastBackup: ?array} $status
     */
    private static function render_duplicator_status_html(array $status): string {
        if (!$status['installed']) {
            return '<span id="csst-duplicator-badge" class="csst-tier csst-tier-unknown">' . esc_html__('Not detected', 'controll-server-connection-speed-test') . '</span> '
                . '<span>' . esc_html__('Duplicator Pro was not detected on this site.', 'controll-server-connection-speed-test') . '</span>';
        }

        $backup = $status['lastBackup'];
        if ($backup === null) {
            return '<span id="csst-duplicator-badge" class="csst-tier csst-tier-unknown">' . esc_html__('No backups', 'controll-server-connection-speed-test') . '</span> '
                . '<span>' . esc_html__('Duplicator Pro is installed but no backups have run yet.', 'controll-server-connection-speed-test') . '</span>';
        }

        $tier = $backup['isSuccess'] ? 'good' : ($backup['isFailure'] ? 'needs-attention' : 'watch');

        return '<span id="csst-duplicator-badge" class="csst-tier csst-tier-' . esc_attr($tier) . '">' . esc_html($backup['statusLabel']) . '</span> '
            . '<span>' . esc_html(sprintf(
                /* translators: 1: backup name, 2: relative time e.g. "5 hours ago" */
                __('"%1$s" — %2$s', 'controll-server-connection-speed-test'),
                $backup['name'],
                $backup['relativeTime'] ?? __('unknown time', 'controll-server-connection-speed-test')
            )) . '</span>';
    }

    public static function ajax_process_list(): void {
        self::verify_request();

        if (!function_exists('shell_exec')) {
            wp_send_json_success([
                'available' => false,
                'message' => 'shell_exec is disabled by hosting.',
                'processes' => [],
            ]);
        }

        $command = "ps -eo pid,user,pcpu,pmem,etime,comm --no-headers --sort=-pcpu 2>/dev/null | head -n 30";
        $raw = @shell_exec($command);

        if (!is_string($raw) || trim($raw) === '') {
            wp_send_json_success([
                'available' => false,
                'message' => 'Process list is not available on this host.',
                'processes' => [],
            ]);
        }

        $lines = preg_split('/\r\n|\r|\n/', trim($raw));
        $processes = [];

        foreach ($lines as $line) {
            $line = trim($line);
            if ($line === '') {
                continue;
            }

            $parts = preg_split('/\s+/', $line, 6);
            if (!is_array($parts) || count($parts) < 6) {
                continue;
            }

            $processes[] = [
                'pid' => sanitize_text_field($parts[0]),
                'user' => sanitize_text_field($parts[1]),
                'cpuPct' => sanitize_text_field($parts[2]),
                'memPct' => sanitize_text_field($parts[3]),
                'elapsed' => sanitize_text_field($parts[4]),
                'command' => sanitize_text_field($parts[5]),
            ];
        }

        wp_send_json_success([
            'available' => true,
            'message' => 'Process list loaded.',
            'processes' => $processes,
            'generatedAt' => current_time('mysql'),
        ]);
    }

    public static function ajax_download_keep_alive_script(): void {
        self::verify_request();

        $site_url = home_url('/');
        $host = (string) parse_url($site_url, PHP_URL_HOST);
        $slug = trim((string) preg_replace('/[^a-zA-Z0-9]+/', '-', $host), '-');
        if ($slug === '') {
            $slug = self::SLUG;
        }

        $task_name = 'CSST-KeepAlive-' . $slug;
        $filename = 'csst-keep-alive-' . $slug . '.ps1';
        $script = self::build_keep_alive_script($site_url, $task_name);

        nocache_headers();
        header('Content-Type: text/plain; charset=utf-8');
        header('Content-Disposition: attachment; filename="' . $filename . '"');
        header('Content-Length: ' . (string) strlen($script));
        echo $script;
        exit;
    }

    private static function build_keep_alive_script(string $site_url, string $task_name): string {
        $escaped_url = str_replace("'", "''", $site_url);
        $escaped_task_name = str_replace("'", "''", $task_name);

        $template = <<<'PS1'
<#
Auto-generated by the Controll Server Connection Speed Test plugin for:
  __SITE_URL__

This copy is pre-configured with the site URL and task name above, so it
needs no arguments to work. Because rebuilding this PC wipes any previously
installed scheduled task, just re-download this script from the plugin's
admin page (Server Speed Test > Keep Server Awake) after a reinstall and run
it again — everything it needs is already baked in below.

Usage:
  .\__TASK_NAME__.ps1              installs the scheduled task (default, no arguments needed)
  .\__TASK_NAME__.ps1 -Uninstall   removes the scheduled task
  .\__TASK_NAME__.ps1 -ShowIp      prints this machine's public IP, to whitelist in Wordfence
  .\__TASK_NAME__.ps1 -PingOnce    sends a single ping without installing anything
#>

param(
    [string]$Url = '__SITE_URL_ESCAPED__',
    [int]$IntervalMinutes = 5,
    [int]$TimeoutSec = 30,
    [string]$LogPath,
    [switch]$Uninstall,
    [switch]$ShowIp,
    [switch]$PingOnce,
    [string]$TaskName = '__TASK_NAME_ESCAPED__'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptPath = $MyInvocation.MyCommand.Path
if (-not $LogPath) {
    $LogPath = Join-Path (Split-Path $scriptPath -Parent) "$TaskName.log"
}

function Write-Log {
    param([string]$Message)
    $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
    Add-Content -Path $LogPath -Value $line
    Write-Host $line
}

function Send-Ping {
    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $response = Invoke-WebRequest -Uri $Url -Method Get -TimeoutSec $TimeoutSec -UseBasicParsing
        $stopwatch.Stop()
        Write-Log "OK   status=$($response.StatusCode) elapsedMs=$($stopwatch.ElapsedMilliseconds) url=$Url"
    } catch {
        $stopwatch.Stop()
        Write-Log "FAIL elapsedMs=$($stopwatch.ElapsedMilliseconds) url=$Url error=$($_.Exception.Message)"
    }
}

if ($ShowIp) {
    $ip = (Invoke-RestMethod -Uri "https://api.ipify.org" -TimeoutSec $TimeoutSec).Trim()
    Write-Host "Public IP of this machine: $ip"
    Write-Host "Add this IP to Wordfence's country blocking allowlist / firewall allowlist so pings from this script aren't blocked as international traffic."
    exit 0
}

if ($Uninstall) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "Removed scheduled task '$TaskName'."
    } else {
        Write-Host "Scheduled task '$TaskName' was not found."
    }
    exit 0
}

if ($PingOnce) {
    Send-Ping
    exit 0
}

# Default: install the scheduled task, so running this script with no
# arguments is enough to set everything up.
$action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$scriptPath`" -PingOnce -Url `"$Url`" -TimeoutSec $TimeoutSec -LogPath `"$LogPath`" -TaskName `"$TaskName`""

$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
    -RepetitionDuration (New-TimeSpan -Days 3650)

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
    -Description "Pings $Url every $IntervalMinutes minute(s) to stop the shared host from sleeping." `
    -Force | Out-Null

Write-Host "Installed scheduled task '$TaskName': pings $Url every $IntervalMinutes minute(s)."
Write-Host "Log file: $LogPath"
Write-Host ""
Write-Host "Note: this task runs on this PC's schedule and only while the PC is on."
Write-Host "Run .\__TASK_NAME__.ps1 -ShowIp and whitelist that IP in Wordfence if pings start getting blocked as international traffic."
PS1;

        return str_replace(
            ['__SITE_URL__', '__SITE_URL_ESCAPED__', '__TASK_NAME__', '__TASK_NAME_ESCAPED__'],
            [$site_url, $escaped_url, $task_name, $escaped_task_name],
            $template
        );
    }
}

register_activation_hook(__FILE__, [CSST_Plugin::class, 'activate']);
register_deactivation_hook(__FILE__, [CSST_Plugin::class, 'deactivate']);

CSST_Plugin::init();