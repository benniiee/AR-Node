<?php

namespace Tests\Feature;

use Tests\TestCase;

class IphoneCheckPageTest extends TestCase
{
    public function test_the_iphone_check_page_is_served_without_signing_in(): void
    {
        if (! is_file(public_path('admin/iphone-check.html'))) {
            $this->markTestSkipped('Needs the built frontend (npm run build).');
        }

        $response = $this->get('/iphone-check');

        $response->assertOk();
        $response->assertHeader('Content-Type', 'text/html; charset=UTF-8');
        $this->assertStringContainsString('iPhone install check', (string) file_get_contents($response->baseResponse->getFile()->getPathname()));
    }
}
