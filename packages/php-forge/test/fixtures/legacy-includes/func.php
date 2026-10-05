<?php
function total($items)
{
    return count($items) + $tax; // expect: undefined-variable
}
